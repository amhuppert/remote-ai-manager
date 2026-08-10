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
    expect(draft).toContain("cctl spec plan edit");
    expect(draft).toMatch(/task.*legacy/i);

    const advance = await helpText(["spec", "advance"]);
    expect(advance).toContain("--from <requirements>");
    expect(advance).not.toContain("<requirements|design>");
    expect(advance).toContain("cctl spec plan open");

    const task = await helpText(["spec", "task"]);
    expect(task).toContain("cctl spec plan edit");

    const propose = await helpText(["spec", "propose"]);
    expect(propose).toContain("cctl spec plan propose");

    const requestApproval = await helpText(["spec", "request-approval"]);
    expect(requestApproval).toContain("cctl spec plan sign-off");

    const remove = await helpText(["spec", "remove"]);
    expect(remove).toMatch(/task handles are legacy-only/i);
    expect(remove).toContain("cctl spec plan edit");

    const preview = await helpText(["spec", "plan", "preview"]);
    expect(preview).toContain("--stage draft|proposed");
    for (const flag of ["scope", "context", "revision"]) {
      expect(preview).toMatch(new RegExp(`--${flag}[^\\n]+retired`, "i"));
    }
    expect(preview).toContain("spec plan open <slug> --seed-from last");
  });

  it("keeps the retired start --file flag recognizable without advertising it as a launch path", async () => {
    const start = await helpText(["spec", "start"]);

    expect(start).toContain("cctl spec start <slug> [--park]");
    expect(start).not.toContain("cctl spec start <slug> --file <scope.json>");
    expect(start).toMatch(/--file[\s\S]{0,240}retired/i);
    expect(start).toContain("cctl spec plan open <slug> --seed-from last");
    expect(start).not.toContain("cctl spec schema scope");
    expect(start).not.toMatch(/starts the legacy way/i);
    expect(start).toContain("proposed or approved candidate");
    expect(start).toContain("receipt reports the plan's projected next act");
  });

  it("surfaces registry-generated guidance on the lint and compilation leaves", async () => {
    const lint = await helpText(["spec", "lint"]);
    expect(lint).toContain("Evergreen lint taxonomy");
    expect(lint).toContain("9.7.claim-without-evidence — blocks_claim");

    const planStatus = await helpText(["spec", "plan", "status"]);
    expect(planStatus).toContain("Delivery-plan lint taxonomy");
    expect(planStatus).toContain("plan/selected-multi-owned — blocks_propose");

    const preview = await helpText(["spec", "plan", "preview"]);
    expect(preview).toContain("Materializer field mappings");
    expect(preview).toContain(
      "contexts[].contextId -> executionContexts[].id (copy)",
    );
    expect(preview).toContain("Evidence producers");
    expect(preview).toContain("test_run <- graph-workflow-validation-result");
    expect(preview).toContain("same validation event");

    const schema = await helpText(["spec", "schema"]);
    expect(schema).toContain("cctl spec schema guidance");

    expect(await generatedReference(["spec", "lint"])).toEqual([
      NATIVE_SDD_GUIDANCE_SECTIONS.evergreenLint,
    ]);
    expect(await generatedReference(["spec", "plan", "status"])).toEqual([
      NATIVE_SDD_GUIDANCE_SECTIONS.deliveryPlanLint,
    ]);
    expect(await generatedReference(["spec", "plan", "preview"])).toEqual([
      NATIVE_SDD_GUIDANCE_SECTIONS.materializer,
      NATIVE_SDD_GUIDANCE_SECTIONS.evidenceProducers,
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
   * about it. If the help names fewer than three exits the agent invents one;
   * if it names more, something other than the audited amendment is being
   * offered as a way to change a launched definition.
   */
  it("presents the three post-launch paths side by side on the capture node", async () => {
    const text = await helpText(["spec", "capture"]);

    expect(text).toContain("exactly three post-launch paths");
    expect(text).toContain("--blocking-reason");
    expect(text).toContain("cctl workflow live amend");
    expect(text).toContain(
      "the only operation that may change a launched definition",
    );
    expect(text).toContain("cctl spec plan open");
  });

  /**
   * Before launch there is no run, so capture has to hand the agent the plan
   * verb rather than a refusal it cannot act on — and the two prelaunch verbs
   * differ by attempt status.
   */
  it("names both prelaunch plan verbs on the capture node", async () => {
    const text = await helpText(["spec", "capture"]);

    expect(text).toContain("cctl spec plan edit");
    expect(text).toContain("cctl spec plan reopen");
  });

  it("reaches the delta from the spec group node", async () => {
    const text = await helpText(["spec"]);

    expect(text).toMatch(
      /spec delta\s+— compare the approved spec against a delivered execution/,
    );
  });
});
