import { describe, expect, it } from "vitest";
import { z } from "zod";

import { NATIVE_SDD_GUIDANCE_SECTIONS } from "@/lib/specs/native-sdd-guidance";

import { runCli } from "../../core";
import type { CliEnv, CliHost } from "../../shared";

const env: CliEnv = {};

function helpHost(): CliHost {
  return {
    async fetch() {
      throw new Error("help must never depend on the server");
    },
    async readTextFile() {
      return null;
    },
    async readFileBytes() {
      return null;
    },
    async sleep() {},
    platform: "darwin",
    homedir: "/Users/test",
  };
}

async function helpText(path: string[]): Promise<string> {
  const result = await runCli([...path, "--help"], env, helpHost());
  expect(result.exitCode).toBe(0);
  return result.stdout;
}

async function generatedReference(path: string[]) {
  const result = await runCli([...path, "--help", "--json"], env, helpHost());
  expect(result.exitCode).toBe(0);
  return z
    .object({
      help: z.object({
        generatedReference: z.array(
          z.object({ title: z.string(), lines: z.array(z.string()) }),
        ),
      }),
    })
    .parse(JSON.parse(result.stdout)).help.generatedReference;
}

describe("cctl spec help nodes", () => {
  it("defines comment row metrics separately from review thread metrics", async () => {
    const text = await helpText(["spec", "comments"]);

    for (const field of [
      "openCount",
      "openBlockingCount",
      "openThreadCount",
      "openBlockingThreadCount",
    ]) {
      expect(text).toContain(field);
    }
    expect(text).toMatch(/openCount[^.]+message rows/i);
    expect(text).toMatch(/openThreadCount[^.]+threads/i);
    expect(text).toContain("spec-wide");
  });

  /**
   * The ordering contract was previously guessed by an authoring agent, and the
   * guess (per-parent order, position implying nesting) was wrong. Every
   * surface that describes the write document has to state the contract the
   * repository actually enforces.
   */
  it("states the element ordering contract wherever the write document is described", async () => {
    for (const path of [
      ["spec", "draft"],
      ["spec", "schema"],
    ]) {
      const text = (await helpText(path)).toLowerCase();
      expect(text, `${path.join(" ")}: no global-order statement`).toContain(
        "one global order per revision",
      );
      expect(text, `${path.join(" ")}: no tiebreak statement`).toContain(
        "elementid",
      );
      expect(text, `${path.join(" ")}: no append-on-omit statement`).toContain(
        "omit position on create",
      );
      expect(text, `${path.join(" ")}: nesting not attributed`).toContain(
        "parentelementid",
      );
    }
  });

  it("points spec draft at the published schema instead of the source", async () => {
    const text = await helpText(["spec", "draft"]);

    expect(text).toContain("cctl spec schema");
  });

  it("routes retired evergreen plan acts to delivery-plan attempts", async () => {
    const draft = await helpText(["spec", "draft"]);
    expect(draft).toContain("cctl workflow replace");

    const advance = await helpText(["spec", "advance"]);
    expect(advance).toContain("--from <requirements>");
    expect(advance).not.toContain("<requirements|design>");
    expect(advance).toContain("cctl spec plan open");

    const propose = await helpText(["spec", "propose"]);
    expect(propose).toContain("cctl spec plan propose");

    const requestApproval = await helpText(["spec", "request-approval"]);
    expect(requestApproval).toContain("cctl spec plan sign-off");

    const remove = await helpText(["spec", "remove"]);
    expect(remove).toContain("Delivery graph tasks are authored only");
    expect(remove).not.toMatch(/legacy-only/i);
    expect(remove).toContain("cctl workflow replace");

    const preview = await helpText(["spec", "plan", "preview"]);
    expect(preview).toContain("--stage draft|proposed");
    for (const flag of ["scope", "context", "revision"]) {
      expect(preview).not.toMatch(new RegExp(`--${flag}\\b`, "i"));
    }
    expect(preview).toContain("server-injected sources, locks, origin");
  });

  it("advertises direct graph inputs while keeping retired scope files recognizable", async () => {
    const start = await helpText(["spec", "start"]);

    expect(start).toContain(
      "cctl spec start <slug> [--inputs .cc/temp/inputs.json] [--park]",
    );
    expect(start).toMatch(/--inputs[\s\S]{0,240}JSON object/i);
    expect(start).not.toContain("cctl spec start <slug> --file <scope.json>");
    expect(start).toMatch(/--file[\s\S]{0,240}retired/i);
    expect(start).toContain("Open an authored delivery attempt");
    expect(start).not.toContain("--seed-from last");
    expect(start).not.toContain("cctl spec schema scope");
    expect(start).not.toMatch(/starts the legacy way/i);
    expect(start).toContain("proposed or approved candidate");
    expect(start).toContain("receipt reports the plan's projected next act");
  });

  it("keeps plan lifecycle guidance on binding and finalized-envelope contracts", async () => {
    const lint = await helpText(["spec", "lint"]);
    expect(lint).toContain("Evergreen lint taxonomy");
    expect(lint).toContain("9.3.uncovered-criterion — blocks_propose");
    expect(lint).not.toContain("blocks_claim");

    const planStatus = await helpText(["spec", "plan", "status"]);
    expect(planStatus).toContain("Delivery-plan lint taxonomy");
    expect(planStatus).not.toContain("plan/selected-multi-owned");

    const preview = await helpText(["spec", "plan", "preview"]);
    expect(preview).toContain("server-injected sources, locks, origin");
    expect(preview).not.toContain("Evidence producers");

    const schema = await helpText(["spec", "schema"]);
    expect(schema).toContain("cctl spec schema guidance");

    expect(await generatedReference(["spec", "lint"])).toEqual([
      NATIVE_SDD_GUIDANCE_SECTIONS.evergreenLint,
    ]);
    expect(await generatedReference(["spec", "plan", "status"])).toEqual([
      NATIVE_SDD_GUIDANCE_SECTIONS.deliveryPlanLint,
    ]);
  });

  /**
   * The batch form is only learnable from the CLI if `--help` shows the shape
   * AND says where the compare-and-swap lives; a caller who reads it as a
   * whole-document write loses the element-granular boundary.
   */
  it("teaches the batch draft form with a worked example and its per-element CAS", async () => {
    const text = await helpText(["spec", "draft"]);

    expect(text).toContain("cctl spec draft <slug> --file <elements.json>");
    expect(text).toContain("baseElementVersion");
    expect(text).toContain("one transaction");
    expect(text).toContain("cctl spec schema element-batch");
  });

  /**
   * Element versions are revision-local: `spec amend` copies the approved
   * content into the new revision at version 1. An author who reuses a version
   * read before the amendment is writing against a version that revision never
   * had, so both the verb that opens the revision and the verb that writes into
   * it have to say so.
   */
  it("states that copied elements restart at version 1 and must be re-read", async () => {
    for (const path of [
      ["spec", "draft"],
      ["spec", "amend"],
    ]) {
      const text = (await helpText(path)).toLowerCase();
      expect(text, `${path.join(" ")}: no version-1 restart`).toContain(
        "restart at 1",
      );
      expect(text, `${path.join(" ")}: no re-read instruction`).toContain(
        "re-read",
      );
    }
  });

  /**
   * The compare-and-swap version travels in the document now, so help that
   * still advertises the flag teaches an invocation every form refuses.
   */
  it("teaches the compare-and-swap as a document field, not a flag", async () => {
    const text = await helpText(["spec", "draft"]);

    expect(text).not.toContain("--base-version");
    expect(text).toContain("baseElementVersion");
  });

  /**
   * A refusal an agent cannot look up teaches nothing but retrying, and a
   * repeat ask that returns the existing record must not read as an escalation.
   */
  it("names how a request-approval ask can be refused and what a repeat does", async () => {
    const text = await helpText(["spec", "request-approval"]);

    for (const code of [
      "stale_revision",
      "gate_not_applicable",
      "invalid_subject",
      "already_satisfied",
    ]) {
      expect(text, `request-approval help omits ${code}`).toContain(code);
    }
    expect(text).toContain("alreadyRequested");
  });

  /**
   * The two-step is retired. A propose files the gate's ask itself, so help
   * that still presents request-approval as the routine second step sends an
   * agent to file a request the server has already filed — and, worse, teaches
   * it to read a propose receipt as owing one.
   */
  it("presents request-approval as the recovery for a propose that could not file", async () => {
    const text = await helpText(["spec", "request-approval"]);

    expect(text).toMatch(/recovery|repair/i);
    expect(text).toContain("cctl spec propose");
    expect(text).toMatch(/delivery[- ]uncertain|not[- ]filed/i);
    // The routine-second-step framing the reflection followed.
    expect(text).not.toMatch(/after (a |the )?propose, (run|use) this/i);
  });

  it("states on the propose node that a successful propose files the ask itself", async () => {
    const text = await helpText(["spec", "propose"]);

    expect(text).toMatch(/files? the gate-scoped approval request/i);
    expect(text).toContain("approvalRequests");
    expect(text).toMatch(/request-approval[\s\S]{0,160}(recovery|repair)/i);
  });

  /**
   * What an omitted --subject means is the whole rule an agent has to know: it
   * asks for the gate, at twelve outstanding subjects or none, and never
   * silently becomes "the one subject that is left". Help that leaves it
   * implicit is what sent agents at per-item requests a gate with a dozen
   * subjects could not make.
   */
  it("states that an omitted --subject asks for the gate itself", async () => {
    const text = await helpText(["spec", "request-approval"]);

    expect(text).toContain("gate as a whole");
    expect(text).toContain("sign-off");
    expect(text).toContain("one entry");
  });

  /**
   * The delivery example must promise exactly what the verb does — it records
   * a durable request; the gate still halts at final publish until a human
   * grants it. Wording that implied the run parks instead of halting was a
   * false promise.
   */
  it("shows a delivery-gate example that does not overpromise halt semantics", async () => {
    const text = await helpText(["spec", "request-approval"]);

    expect(text).toContain(
      "cctl spec request-approval audit-log --gate delivery",
    );
    expect(text).toContain(
      "the gate still stops at final publish until a human grants it",
    );
  });

  /**
   * `spec amend` has two refusals, so help naming only one misleads. An agent
   * that reads not_found as the whole failure surface treats a review-blocked
   * amendment as a missing spec and re-creates it.
   */
  it("names both amend refusals and every way the review concludes", async () => {
    const text = await helpText(["spec", "amend"]);

    expect(text).toContain("not_found");
    expect(text).toContain("revision_in_review");
    expect(text).toContain("sign-off");
    // Two of the three exits are human acts on a human surface; the third is
    // this agent's own, and an agent told only about the human ones waits.
    expect(text).toContain("requesting changes");
    expect(text).toContain("cctl spec withdraw-proposal");
  });

  /**
   * Both writing verbs teach the same recovery set, so an agent refused at a
   * draft write is not told to wait for a human it could unblock itself.
   */
  it("names the agent-side exit on both revision_in_review nodes", async () => {
    for (const path of [
      ["spec", "amend"],
      ["spec", "draft"],
    ]) {
      const text = await helpText(path);
      expect(text, `${path.join(" ")}: agent exit not named`).toContain(
        "cctl spec withdraw-proposal",
      );
    }
  });

  /**
   * The verb is guarded, and every guard is a reason an agent's call can fail
   * after it decided to make it. Help that names the verb without its guards
   * teaches a recovery that refuses.
   */
  it("teaches the withdraw-proposal guards and its compare-and-swap token", async () => {
    const text = await helpText(["spec", "withdraw-proposal"]);

    expect(text).toContain("proposal_not_owned");
    expect(text).toContain("gate_blocked");
    // Authorship, prior human engagement, and the one-editable-revision rule.
    expect(text).toContain("proposed");
    expect(text).toContain("approval");
    expect(text).toContain("thread");
    expect(text).toContain("--revision <revision-id>");
    expect(text).toContain("never inferred");
    // An open comment is explicitly not a blocker, or agents will route every
    // commented revision back to a human.
    expect(text).toMatch(/open .*comment/i);
  });

  it("routes propose, amend, and request-approval at the agent-side exit and back", async () => {
    for (const path of [
      ["spec", "propose"],
      ["spec", "amend"],
      ["spec", "request-approval"],
    ]) {
      expect(
        await helpText(path),
        `${path.join(" ")}: no outbound edge`,
      ).toContain("spec withdraw-proposal");
    }
    const withdraw = await helpText(["spec", "withdraw-proposal"]);
    for (const command of [
      "spec propose",
      "spec amend",
      "spec draft",
      "spec request-approval",
    ]) {
      expect(
        withdraw,
        `withdraw-proposal: no edge back to ${command}`,
      ).toContain(command);
    }
  });

  /**
   * A withdrawn revision is terminal, so the amendment starts short of the
   * last authored content. An agent that cannot learn this from the help
   * treats the reopened draft as carrying work it does not carry.
   */
  it("says that a withdrawn revision's content is not carried into the amendment", async () => {
    const text = await helpText(["spec", "amend"]);

    expect(text).toContain("skippedWithdrawnRevisions");
    expect(text).toContain("not carried");
  });

  it("routes the amend node at the verb that ends a pending review", async () => {
    const amend = await helpText(["spec", "amend"]);
    expect(amend).toContain("spec request-approval");

    const requestApproval = await helpText(["spec", "request-approval"]);
    expect(requestApproval).toContain("spec amend");
  });

  /**
   * A draft write into a revision under review is a different refusal from a
   * write into approved content, and the two recoveries contradict each other
   * if the help teaches only "open an amendment".
   */
  it("separates the proposed-revision draft refusal from the approved one", async () => {
    const text = await helpText(["spec", "draft"]);

    expect(text).toContain("revision_in_review");
    expect(text).toContain("amendment_required");
  });

  /**
   * Every write that carries element ids is now refused at the write itself
   * rather than at propose, so both writing verbs have to name the refusal and
   * the fact that an empty id array is still legal — an agent told only
   * "dangling" invents ids to satisfy the arrays.
   */
  it("names the dangling-reference refusal on both writing verbs", async () => {
    for (const path of [
      ["spec", "draft"],
      ["spec", "capture"],
    ]) {
      const text = await helpText(path);
      expect(text, `${path.join(" ")}: refusal not named`).toContain(
        "dangling_reference",
      );
      expect(text, `${path.join(" ")}: empty arrays not blessed`).toContain(
        "empty",
      );
    }
  });

  /**
   * The reported recovery for an orphaned element id was renaming 20 elements
   * around the dead ids. The draft node has to name the refusal and the retry
   * that revives the identity, or the rename stays the only visible way out.
   */
  it("teaches the reintroduction retry for an orphaned element id", async () => {
    const text = await helpText(["spec", "draft"]);

    expect(text).toContain("historical_element_id");
    expect(text).toContain("reintroduceHistorical");
    expect(text).toContain("element_id_taken");
  });

  /**
   * The propose receipt can send the caller at `spec status` — for a sign-off
   * or an unmet condition no agent verb clears — so the two nodes have to point
   * at each other rather than leaving that hop undocumented.
   */
  it("routes propose and status at each other", async () => {
    const propose = await helpText(["spec", "propose"]);
    expect(propose).toContain("spec status");

    const status = await helpText(["spec", "status"]);
    expect(status).toContain("spec propose");
  });

  /**
   * Status reports two different outstanding things and the reason a gate is
   * or is not consulted. Help that still promises only "gate state, pending
   * approvals" teaches the reading ticket #42 reported as a contradiction.
   */
  it("says status reports subject approvals and revision sign-off separately", async () => {
    const text = await helpText(["spec", "status"]);

    expect(text).toContain("why it is or is not consulted");
    expect(text).toContain("subject approvals still outstanding");
    expect(text).toContain("explicit human sign-off");
  });

  /**
   * The propose receipt names the gates and subjects itself. Help that leaves
   * that unsaid invites the caller to derive a gate from the authoring stage,
   * which is the wrong gate whenever an earlier stage is also consulted.
   */
  it("points propose at the server's pending block rather than the stage", async () => {
    const text = await helpText(["spec", "propose"]);

    expect(text).toContain("pending block");
    expect(text).toContain(
      "rather than inferring a gate from the revision's authoring stage",
    );
    expect(text).toContain("nearest approved ancestor");
  });

  it("offers project-wide discovery from the search node", async () => {
    const text = await helpText(["spec", "search"]);

    expect(text).toContain("cctl spec search --all <query>");
  });

  /**
   * The default pair is the whole point of the verb: a reviewer who reads it
   * as "diff against the last approved revision" would take a different set of
   * changes to the sign-off than Spec Studio shows.
   */
  it("names the default diff pair and the explicit governance baseline", async () => {
    const text = await helpText(["spec", "diff"]);

    expect(text).toContain("immediate review base");
    expect(text).toContain("--baseline governance");
    expect(text).toContain("nearest APPROVED ancestor");
  });

  /**
   * Export stopped printing the bundle on 2026-08-07. A caller who reads only
   * the old help pipes an empty bundle, so the node has to state the new
   * default, the flag that restores the old one, and the date it changed.
   */
  it("documents the changed export default and the flag that restores stdout", async () => {
    const text = await helpText(["spec", "export"]);

    expect(text).toContain("--stdout");
    expect(text).toContain("2026-08-07");
    expect(text).toContain(".cc/temp/<slug>-spec-bundle.json");
    expect(text).toContain("content hash");
  });

  /**
   * The delta is only worth reading if the caller knows what it is for. An
   * agent about to author the next delivery plan has to learn from the help
   * itself that this is that plan's input, and that a capped listing is not
   * the whole answer.
   */
  it("names the delta as the authoring input for the next execution's plan", async () => {
    const text = await helpText(["spec", "delta"]);

    expect(text).toContain(
      "the authoring input for the next execution's delivery plan",
    );
    expect(text).toContain("--since <executionId>");
    expect(text).toContain("capped at 30 rows");
    expect(text).toContain("--out writes the complete projection JSON");
  });

  /**
   * An agent that finds work mid-run reads this node to learn what it may do
   * about it. The launch is immutable, so the help presents the two paths that
   * preserve it.
   */
  it("presents the two post-launch paths side by side on the capture node", async () => {
    const text = await helpText(["spec", "capture"]);

    expect(text).toContain("Non-blocking capture and blocking capture");
    expect(text).toContain("--blocking-reason");
    expect(text).toContain("cctl spec plan open");
  });

  /**
   * Before launch there is no run, so capture has to hand the agent the plan
   * verb rather than a refusal it cannot act on — and the two prelaunch verbs
   * differ by attempt status.
   */
  it("names both prelaunch plan verbs on the capture node", async () => {
    const text = await helpText(["spec", "capture"]);

    expect(text).toContain("cctl workflow replace");
    expect(text).toContain("cctl spec plan reopen");
  });

  /**
   * Import is the one verb that creates a spec already past its authoring
   * gates, so every way it refuses has to be readable before the call — and the
   * delivered-without-criteria refusal is only actionable if its opt-out is
   * named beside it.
   */
  it("documents the import verb's flags, refusals, and the opt-out each one names", async () => {
    const text = await helpText(["spec", "import"]);

    expect(text).toContain("cctl spec import --file <bundle.json>");
    expect(text).toContain("--dry-run");
    for (const code of ["slug_taken", "lint_blocked", "validation"]) {
      expect(text, `spec import help omits ${code}`).toContain(code);
    }
    // The refusal an agent hits importing a criteria-less source, and the one
    // field that clears it.
    expect(text).toContain('"delivered": false');
    expect(text).toContain("cctl spec schema import-bundle");
    // Nothing the import writes may read as a human approval.
    expect(text).toMatch(/import provenance/i);
    // A bundle that declares its own rehearsal rehearses on every invocation,
    // so the field that ends it has to be named where the flag is documented.
    expect(text).toContain('"dryRun": false');
  });

  /**
   * A spec that already exists is amended, never imported: an agent that reads
   * import as an upsert would reach for it to update a spec and get slug_taken
   * with no route onward.
   */
  it("routes import at the verbs for a spec that already exists", async () => {
    const text = await helpText(["spec", "import"]);

    for (const command of [
      "spec list",
      "spec search",
      "spec amend",
      "spec schema",
    ]) {
      expect(text, `spec import help omits ${command}`).toContain(command);
    }
    // Import leads to the direct delivery-plan entry point only after the
    // imported spec is ready for delivery.
    expect(text).toContain("cctl spec plan open");
    expect(text).not.toContain("--seed-from last");
  });

  /**
   * The two receipts route differently — a delivered import owes nothing, an
   * undelivered one owes a delivery plan — so the help has to name both rather
   * than leaving the second to be discovered from a receipt nobody read.
   */
  it("names both next steps an import receipt hands back", async () => {
    const text = await helpText(["spec", "import"]);

    expect(text).toContain("cctl spec show <slug>");
    expect(text).toContain("cctl spec plan open <slug>");
  });

  /**
   * The authoring path a planner meets first (#80 design 3.6). Both nodes carry
   * it because either one can be the entry: the group is where a planner
   * browses, `spec plan open` is where the attempt actually starts.
   */
  it("routes plan authoring through plan.json, the preflight, and workflow replace", async () => {
    const group = await helpText(["spec", "plan"]);
    const open = await helpText(["spec", "plan", "open"]);

    for (const [name, text] of [
      ["spec plan", group],
      ["spec plan open", open],
    ] as const) {
      expect(text, name).toContain("plan.json");
      expect(text, name).toContain("cctl workflow validate --file");
      expect(text, name).toContain("--definition");
      expect(text, name).toContain("cctl workflow replace");
      // Named once, and only as the surface a human reviews on: two mentions
      // is how it became a second authoring path in the first place.
      expect((text.match(/Workflow Builder/gu) ?? []).length, name).toBe(1);
    }
  });

  it("no longer presents cctl workflow edit as the way to author a draft", async () => {
    const open = await helpText(["spec", "plan", "open"]);

    expect(open).not.toMatch(/author it with `cctl workflow edit/u);
    expect(open).toMatch(/targeted change/u);
    expect(open).not.toContain("spec plan edit");
  });

  it("teaches the bounded show disclosure ladder without using JSON as a depth control", async () => {
    const text = await helpText(["spec", "show"]);

    expect(text).toContain("bounded nested outline");
    expect(text).toContain("--summary");
    expect(text).toContain("--rendered");
    expect(text).toContain("--full");
    expect(text).toContain("--out");
    expect(text).toContain(".cc/temp/");
    expect(text).toContain("stdout budget");
    expect(text).toContain("storage: artifact");
    expect(text).toMatch(/--json[^\n]+does not (?:change|widen)/i);
    expect(text).toContain("cctl spec show native-sdd");
    expect(text).toContain("cctl spec show native-sdd --rendered");
  });

  it("reaches the delta from the spec group node", async () => {
    const text = await helpText(["spec"]);

    expect(text).toMatch(
      /spec delta\s+— compare the approved spec against a delivered execution/,
    );
  });

  /**
   * Sections are the one element kind with no handle, and the reflection's
   * author guessed a handle for them rather than concluding none exists. The
   * help has to say the rule at both doors: `spec get` is not the section read,
   * and `spec section get` takes an element id because there is nothing else.
   */
  it("teaches the handle-less section read and routes it from the handle read", async () => {
    const leaf = await helpText(["spec", "section", "get"]);
    const group = await helpText(["spec", "section"]);
    const root = await helpText(["spec"]);
    const get = await helpText(["spec", "get"]);

    expect(leaf).toContain("cctl spec section get <slug> --id <element-id>");
    expect(leaf).toContain("--id");
    expect(leaf).toContain("--revision");
    expect(leaf.toLowerCase()).toContain("no handle");
    expect(leaf).toContain("cctl spec show");
    expect(leaf).toContain("historical_only");

    // A hub points at its leaves rather than restating their usage, so the
    // group and the root are checked for the route, not for the shape.
    expect(group).toMatch(
      /spec section get\s+— read one section by its element id/,
    );
    expect(group.toLowerCase()).toContain("no handle");
    expect(root).toMatch(/spec section\s+— read the prose sections/);
    // The two reads have to name each other: an agent holding a handle and an
    // agent holding an element id each arrive at exactly one of them.
    expect(get).toContain("spec section get");
    expect(leaf).toContain("spec get");
  });
});
