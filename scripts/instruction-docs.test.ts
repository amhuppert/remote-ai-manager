import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig as resolveVitestConfig } from "vitest/node";

import { specHelpEntries } from "../src/cli/commands/spec/spec.help";
import {
  renderRuntimeSpecInstructions,
  SPEC_GUIDANCE_SECTIONS,
} from "../src/lib/conversation-commands/native-spec-guidance";

const root = process.cwd();

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

/** Guidance prose wraps at authoring width; a claim spans its line breaks. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ");
}

/**
 * The body of one `## ` section, from its heading to the next one, collapsed.
 *
 * Claims are checked against this slice rather than the whole document because
 * several of them are things OTHER sections already say: `cctl spec amend` is
 * the amendments section's subject and `--seed-from last` is the execution-start
 * section's, so a whole-document search stays green after those statements are
 * deleted from the importing section itself — which is exactly the drift these
 * tests exist to catch.
 */
function markdownSection(document: string, heading: string): string {
  const marker = `## ${heading}`;
  const start = document.indexOf(marker);
  if (start === -1) return "";
  const rest = document.slice(start + marker.length);
  const next = rest.search(/^## /m);
  return collapse(next === -1 ? rest : rest.slice(0, next));
}

/**
 * What an agent must be told about `cctl spec import`, phrase by phrase, on
 * EVERY surface that teaches it: the runtime `/spec` block, the generated
 * command document, and the conversation-loaded plugin skill.
 *
 * The list is the importing section's whole content contract, not a sample of
 * it — every mandatory statement in R12.1–R12.3 has a phrase here, so deleting
 * any one of them from any surface fails. The claims are shared across surfaces
 * rather than written per-surface because the failure this guards is one
 * surface teaching a workflow the others no longer state: an agent that reads
 * only the skill and skips the dry-run-until-clean loop imports a bundle whose
 * cross-references name handles the importer never allocated, and an agent that
 * misses the review-noise conventions lands a delivered import carrying open
 * questions and undisposed assumptions — costing a human exactly the review
 * pass an import is supposed to avoid.
 */
const SPEC_IMPORT_GUIDANCE_CLAIMS = [
  // What an imported spec's approved state actually rests on. A surface that
  // drops this reads as though a human approved the content.
  "import provenance",
  "no approval of any kind",
  // R12.1 — the workflow, every step of it.
  "cctl spec list", // verify no existing spec covers the work…
  "cctl spec search --all", // …by list AND search
  "you are the parser", // author the bundle from the source
  "the server never reads", // …because nothing else will
  "--dry-run", // iterate against the rehearsal…
  "no blocking finding", // …until it comes back CLEAN
  "import once",
  "read the receipt", // the step that tells you what is still owed
  "refusal as unfinished work",
  // R12.2 — the boundaries.
  "creates new specs only",
  "cctl spec amend", // the path an existing spec changes through
  "never an approval shortcut",
  "--seed-from last", // the legacy delivery-plan seed import is NOT
  // R12.3 — the review-noise conventions.
  "`delivered` defaults to true",
  '"delivered": false', // the explicit opt-out…
  "no acceptance criterion", // …and the criteria-less source it is required for
  "answered when the source holds the answer",
  "confirmed included",
  "not the human disposition act", // importing a disposition is provenance capture
  "zero open review items",
] as const;

/**
 * A token that neighbouring sections own and the importing section does not.
 * Asserted present in the whole document and absent from the slice, so an
 * extractor that silently widened to the full document — the exact bug that
 * makes every claim above vacuous — fails loudly instead of passing quietly.
 */
const SPEC_GUIDANCE_NEIGHBOUR_TOKEN = "stage_blocked";
const SKILL_NEIGHBOUR_TOKEN = "reintroduceHistorical";

/**
 * The skill states the same contract in its own register, so its heading is
 * its own — pinned here because the section is addressed by heading, and the
 * Codex packaging test pins this exact string in its shipped section list.
 */
const SKILL_IMPORT_SECTION_HEADING = "Importing a spec authored outside CC";

/**
 * The sources-of-truth section's whole content contract. Every phrase is a
 * mandatory statement, not a sample: the reserved locator a planner must not
 * invent, the grade that makes it readable, the grade it is NOT, and the lint
 * that refuses the difference.
 */
const SKILL_SOURCES_SECTION_HEADING = "Ranked sources of truth a lane can read";
const SPEC_SOURCE_GUIDANCE_CLAIMS = [
  ".cc/graph-workflow-docs/spec/", // the reserved locator, owned by the engine
  "rank 1", // where the plan's own spec belongs
  "worktree-relative", // the grade that makes it readable in a lane
  "external-readonly", // …and what that other grade is left for
  "plan/spec-source-unreadable", // the refusal an author will otherwise meet
  "cctl spec plan open", // the verb that already seeded the entry
  "cctl spec schema guidance", // the generated registry every section points at
] as const;

/**
 * The plan-tier placement section's whole content contract. Every phrase is a
 * mandatory statement, not a sample: the instruction to put a chain on one
 * lane, the ordering that makes that safe, the saving it buys, what unordered
 * lane-mates owe each other and at what grain, the grade this tier refuses,
 * the default an unsure author falls back to, and the cross-link to the full
 * model.
 *
 * The instruction is pinned separately from its rationale because they drift
 * apart in exactly one direction: prose that keeps "edge-ordered" and the
 * worktree/join arithmetic but loses "put the whole chain on one lane" reads
 * as though edge ordering ALONE consolidates lanes, which is false — placement
 * is authored, never inferred.
 *
 * A planner reads this section INSTEAD of the graph-tier one — the plan
 * document is the only surface it authors — so a dropped statement is not a
 * thinner explanation, it is a plan that lands wrong: same-lane members with
 * overlapping prefixes refuse at propose, a readOnly placement refuses after
 * the author believed all three grades were usable, and a chain that could
 * have cost one worktree pays for N.
 */
const SKILL_PLACEMENT_SECTION_HEADING =
  "Placement: shared lanes and disjoint ownership";
const SPEC_PLACEMENT_GUIDANCE_CLAIMS = [
  "put the whole chain on one lane", // the authoring decision itself…
  "edge-ordered", // …the shape that makes it safe…
  "one worktree and one join instead of N and N", // …and what it saves
  "that no edge orders", // the condition that makes disjointness owed…
  "disjoint `ownedPaths`", // …what is owed under it…
  "segment-boundary", // …and the grain the cover test actually uses
  "`readOnly` is not yet authorable", // the mirrored grade this tier refuses…
  "admits read-only contexts only", // …and the `session` lane it puts out of reach
  "omit `placement`", // the fallback when the shape is unclear…
  "solo lane", // …and the placement it compiles to
  "Lane Placement and File Ownership", // the graph-tier section holding the rest
  "cctl spec schema guidance", // the generated registry every section points at
] as const;

/**
 * The plan-edit help's placement statements: the field an author would
 * otherwise never learn is authorable, and the default that makes omitting it
 * safe. `--help` is the surface an agent reaches for after the skill, and the
 * one an agent outside this repository reaches for INSTEAD of it.
 */
const PLAN_EDIT_HELP_CLAIMS = [
  "`placement`", // the authorable field…
  "its own solo lane", // …and what omitting it costs
  "omit it",
] as const;

/**
 * A token a neighbouring help entry owns and `spec plan edit` does not, so a
 * slice that silently widened to the whole registry — which would make every
 * claim above vacuous — fails loudly instead of passing quietly.
 */
const PLAN_EDIT_HELP_NEIGHBOUR_TOKEN = "plan hash";

function expectImportSectionStatesItsContract(
  whole: string,
  heading: string,
  neighbourToken: string,
  surface: string,
): void {
  const section = markdownSection(whole, heading);
  expect(section, `${surface} has no "## ${heading}" section`).not.toBe("");

  // The slice really is one section: it stops before the next heading, and a
  // neighbour-owned token the document demonstrably contains is outside it.
  expect(section).not.toContain("## ");
  expect(
    collapse(whole),
    `${surface} no longer contains the neighbour token this check is calibrated against`,
  ).toContain(neighbourToken);
  expect(
    section,
    `${surface}'s import section leaked into a neighbouring section`,
  ).not.toContain(neighbourToken);

  for (const claim of SPEC_IMPORT_GUIDANCE_CLAIMS) {
    expect(
      section,
      `${surface}'s import section is missing: ${claim}`,
    ).toContain(claim);
  }
}

/**
 * The agent-facing instruction surfaces, repository-wide: an agent reads these
 * as CURRENT instruction, so a token naming a removed mechanism here is a
 * false statement rather than a historical note. Enumerated as git pathspecs
 * so a newly added skill, steering document, or design doc is swept the moment
 * it is tracked, without anyone remembering to register it.
 */
const GUIDANCE_PATHSPECS = [
  "AGENTS.md",
  "CLAUDE.md",
  "CONTEXT.md",
  ".kiro/steering",
  ".claude/skills",
  ".agents",
  "plugins",
  "docs",
] as const;

function guidanceFiles(): string[] {
  return execFileSync("git", ["ls-files", "-z", "--", ...GUIDANCE_PATHSPECS], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => path.length > 0);
}

function guidanceFilesContaining(pattern: RegExp): string[] {
  return guidanceFiles().filter((path) => pattern.test(read(path)));
}

/** The env vars Vitest reads worker limits from, ranked above any caller. */
const FORK_LIMIT_ENV_VARS = ["VITEST_MAX_FORKS", "VITEST_MIN_FORKS"] as const;

/**
 * Clear the fork-limit env for one resolution, restoring exactly what was there.
 *
 * A cleared var must come back ABSENT rather than as the string "undefined",
 * which is what assigning `undefined` to `process.env` would leave behind — the
 * outer runner keeps reading these after this test finishes.
 */
function withoutForkEnv(): { restore: () => void } {
  const saved = FORK_LIMIT_ENV_VARS.map(
    (name) => [name, process.env[name]] as const,
  );
  for (const [name] of saved) delete process.env[name];

  return {
    restore: () => {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    },
  };
}

describe("agent instruction and canonical documentation contracts", () => {
  it("keeps tool-agnostic instructions canonical and Claude guidance additive", () => {
    const agents = read("AGENTS.md");
    const claude = read("CLAUDE.md");

    expect(agents).toContain("bun install");
    expect(agents).toContain(".kiro/steering/agent-backends.md");
    expect(claude).toContain("@AGENTS.md");
    expect(claude).not.toContain("memory-bank/focus.md");
    expect(claude).not.toContain("ai-resources:browser-automation");
    expect(`${agents}\n${claude}`).not.toContain("git checkout HEAD --");
  });

  it("describes the neutral backend and current session-creation model", () => {
    const product = read(".kiro/steering/product.md");
    const tech = read(".kiro/steering/tech.md");

    expect(product).toContain("Claude and Codex");
    expect(product).not.toContain("Fast and Focus creation modes");
    expect(tech).toContain("src/lib/agent-backends/");
    expect(tech).not.toContain("Claude Code driven via");
    expect(existsSync(resolve(root, ".kiro/steering/agent-backends.md"))).toBe(
      true,
    );
  });

  it("routes state resolution and SSE through their canonical seams", () => {
    const structure = read(".kiro/steering/structure.md");
    const logs = read(".kiro/steering/logs.md");
    const notifications = read(".kiro/steering/notifications.md");

    expect(structure).toContain("RouteResolution");
    expect(logs).toContain("backendRef");
    expect(logs).not.toContain("claudeSessionId");
    expect(logs).toContain("events/publication.ts");
    expect(notifications).toContain("PublishFn");
    expect(notifications).not.toContain("Internal SSE broadcasts");
  });

  it("keeps structured-output transport and recovery guidance current", () => {
    const structured = read("docs/structured-data-responses.md");

    expect(structured).toContain('structuredOutput: "post_validation"');
    expect(structured).toContain('structuredOutput: "backend_native"');
    expect(structured).toContain("bounded repair turn");
    expect(structured).not.toContain("projectSchemaForClaude");
    expect(structured).not.toContain("schema inventory");
    expect(structured).not.toContain(
      "src/lib/workflows/collaboration/schemas.test.ts",
    );
  });

  it("documents validator authority, the advisory loop, and the uncertified posture", () => {
    const workflows = read(".kiro/steering/workflows.md");

    // The authority axis and where it is authored.
    expect(workflows).toContain('"authority"');
    expect(workflows).toContain("validatorAuthoritySchema");
    // The loop an advisory travels: delivery, disposition, re-certification.
    expect(workflows).toContain("advisory_response");
    expect(workflows).toContain("addressed");
    expect(workflows).toContain("declined");
    expect(workflows).toContain("deferred");
    // The posture an advisory-only cohort ships under.
    expect(workflows).toContain("uncertified");
    expect(workflows).toContain("validator-less context");
  });

  it("labels completed and historical documents truthfully", () => {
    expect(read("docs/composable-workflow-primitives.md")).toContain(
      "Superseded",
    );
    expect(
      read(
        "docs/reports/2026-07-12_consolidated-architecture-design-and-plan.md",
      ).slice(0, 1_000),
    ).toContain("Implemented");
    expect(
      read("docs/design/2026-07-12_phase-1-slice-designs.md"),
    ).not.toContain("needs Alex sign-off");
    expect(read("docs/design/conversation-compaction/README.md")).toContain(
      "**Status:** Implemented",
    );
    expect(read("docs/design/cc-cli/README.md")).toContain(
      "**Status:** Implemented",
    );
    expect(read("docs/design/cc-cli/06-workflow-live-editing.md")).toContain(
      "Status: **implemented**",
    );
  });

  it("keeps operator and AI-output guidance current", () => {
    const logging = read("docs/logging.md");
    const aiOutput = read("docs/ai-validation-output.md");

    expect(logging).not.toContain("cc-debug.log");
    expect(logging).not.toContain("/api/hooks");
    expect(logging).toContain(".kiro/steering/logs.md");
    expect(aiOutput).toContain("AI_OUTPUT=1");
    expect(aiOutput).toContain("validation.commands");
    expect(aiOutput).toContain("validation.preMerge");
    expect(aiOutput).toContain("scripts/validate/");
    expect(aiOutput).not.toContain("preMergeCommand");
    expect(aiOutput).not.toContain("scripts/pre-merge-validate.sh");
  });

  it("keeps dev-server setup focused on current project configuration", () => {
    const devServerSetup = read(
      "plugins/command-center/command-center/skills/dev-server-setup/SKILL.md",
    );
    const commandCenterReference = read(
      "plugins/command-center/command-center/skills/dev-server-setup/references/commandcenter-json.md",
    );
    const guidance = `${devServerSetup}\n${commandCenterReference}`;

    expect(devServerSetup).toContain("validation");
    expect(commandCenterReference).toContain("validation.commands");
    expect(commandCenterReference).toContain("validation.preMerge");
    expect(guidance).not.toContain("preMergeCommand");
    expect(guidance).not.toContain("scripts/pre-merge-validate.sh");
  });

  it("keeps project setup validation commands scoped and honestly budgeted", () => {
    const projectSetup = read(
      "plugins/command-center/command-center/skills/project-setup/SKILL.md",
    );
    const wrapperReference = read(
      "plugins/command-center/command-center/skills/project-setup/references/pre-merge-script.md",
    );
    const vitestReference = read(
      "plugins/command-center/command-center/skills/project-setup/references/vitest.md",
    );
    const jestReference = read(
      "plugins/command-center/command-center/skills/project-setup/references/jest.md",
    );
    const projectSetupReferences = [
      "commandcenter-json.md",
      "pre-merge-script.md",
      "eslint.md",
      "prettier.md",
      "typescript.md",
      "vitest.md",
      "jest.md",
    ]
      .map((name) =>
        read(
          `plugins/command-center/command-center/skills/project-setup/references/${name}`,
        ),
      )
      .join("\n");

    expect(projectSetup).toContain("## Register Validation Commands");
    expect(projectSetup).toContain("scripts/validate/");
    expect(projectSetup).toContain("TARGET_BRANCH");
    expect(projectSetup).toContain("git merge-base");
    expect(projectSetup).toContain("--changed");
    expect(projectSetup).toContain('`pathArgs: "paths"`');
    expect(projectSetup).toContain("`command.changed`");
    expect(projectSetup).toContain("`command.full`");
    expect(projectSetup).toContain("never parse");
    expect(projectSetup).not.toContain("scopeArgs");
    expect(projectSetup).toContain("one unit per configured worker");
    expect(projectSetup).toContain("silent on success");
    expect(projectSetup).toContain("complete on failure");
    expect(projectSetup).toContain("no color");
    expect(projectSetup).toContain("`preMerge`");
    expect(projectSetup).toContain("`laneMerge`");
    expect(projectSetup).not.toContain("preMergeCommand");
    expect(projectSetupReferences).toContain("validation.commands");
    expect(projectSetupReferences).not.toContain("preMergeCommand");
    expect(projectSetupReferences).not.toContain(
      "scripts/pre-merge-validate.sh",
    );
    expect(projectSetup).toContain("overwrite `NODE_OPTIONS`");
    expect(projectSetup).not.toContain(
      "inside the wrapper or its fixed tool configuration",
    );
    expect(projectSetup).not.toContain(
      "wrapper or immutable runner configuration",
    );
    expect(wrapperReference).toContain(
      "Runner configuration may mirror these limits but must not own enforcement",
    );

    for (const testRunnerReference of [vitestReference, jestReference]) {
      expect(testRunnerReference).toContain("TEST_WORKERS=4");
      expect(testRunnerReference).toContain("TEST_HEAP_MB=2048");
      expect(testRunnerReference).toContain(
        'export NODE_OPTIONS="--max-old-space-size=${TEST_HEAP_MB}"',
      );
    }
    expect(jestReference).toContain('--maxWorkers="$TEST_WORKERS"');
    expect(vitestReference).toContain(
      'export VITEST_MAX_FORKS="$TEST_WORKERS"',
    );
    expect(vitestReference).toContain('pool: "forks"');
    expect(vitestReference).toContain("maxWorkers: testWorkers");
    expect(vitestReference).toContain(
      'import { startVitest } from "vitest/node"',
    );
    expect(vitestReference).toContain("await startVitest(");
    expect(vitestReference).toContain(
      "execArgv: [`--max-old-space-size=${testHeapMb}`]",
    );
    expect(vitestReference).toContain(
      "programmatic options after the candidate configuration",
    );
    expect(vitestReference).not.toContain(
      "may repeat the cap through `execArgv`",
    );
  });

  it("keeps wrapper-owned Vitest limits above candidate configuration", async () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "cc-vitest-config-"));
    const configPath = join(fixtureRoot, "vitest.config.mjs");
    writeFileSync(
      configPath,
      `export default {
        test: {
          pool: "forks",
          maxWorkers: 32,
          poolOptions: {
            forks: {
              maxForks: 32,
              execArgv: ["--max-old-space-size=8192"],
            },
          },
        },
      };`,
    );

    // The claim under test is programmatic-options-beat-candidate-file. Vitest
    // applies VITEST_MAX_FORKS/VITEST_MIN_FORKS AFTER both — and
    // scripts/validate/test.sh exports them, so the wrapper running this suite
    // would decide the nested resolution below and the assertions would read
    // the outer run's worker count instead of the precedence under test. The
    // fixture already isolates the root and the config file; the env is the
    // third ambient input, withheld here and restored afterwards.
    const forkEnv = withoutForkEnv();

    try {
      const { vitestConfig } = await resolveVitestConfig({
        root: fixtureRoot,
        config: configPath,
        pool: "forks",
        maxWorkers: 4,
        poolOptions: {
          forks: {
            maxForks: 4,
            minForks: 1,
            execArgv: ["--max-old-space-size=2048"],
          },
        },
      });

      expect(vitestConfig.maxWorkers).toBe(4);
      expect(vitestConfig.poolOptions?.forks?.maxForks).toBe(4);
      expect(vitestConfig.poolOptions?.forks?.execArgv).toEqual([
        "--max-old-space-size=2048",
      ]);
    } finally {
      forkEnv.restore();
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  /**
   * Guidance may only name a command the registry actually resolves. An agent
   * is told to run registered validation exclusively through `cctl validate
   * run <name>`, so a documented name that is absent from the registry is a
   * dead end at the moment the agent is least able to improvise: it has been
   * forbidden the direct invocation that would otherwise substitute. Renaming
   * or folding a command is the drift this catches — `test-full-suite` became
   * `test --scope full`, and `build`/`seams` were only ever steps inside
   * `typecheck`.
   */
  it("only names validation commands the registry resolves", () => {
    const allowlist = new Map<string, string>([
      [
        "docs/reports/validation-concurrency-live-e2e-2026-08-05.md",
        "dated live-e2e transcript quoting the run's own fixture command names",
      ],
    ]);
    const registered = new Set(
      Object.keys(
        (
          JSON.parse(read("CommandCenter.json")) as {
            validation: { commands: Record<string, unknown> };
          }
        ).validation.commands,
      ),
    );

    const unresolvable = guidanceFiles()
      .filter((path) => !allowlist.has(path))
      .flatMap((path) =>
        [...read(path).matchAll(/cctl validate run ([a-z][a-z0-9-]*)/g)]
          .map((match) => match[1] ?? "")
          .filter((name) => !registered.has(name))
          .map((name) => `${path}: ${name}`),
      );

    expect(unresolvable).toEqual([]);
  });

  it("keeps agent validation guidance on the server-owned policy path", () => {
    const agents = read("AGENTS.md");
    const agentContext = read(
      "plugins/command-center/command-center/skills/agent-context/SKILL.md",
    );
    const graphPlanning = read(
      "plugins/command-center/command-center/skills/graph-workflow-planning/SKILL.md",
    );
    const localAgentGraphPlanning = read(
      ".agents/skills/graph-workflow-planning/SKILL.md",
    );
    const localClaudeGraphPlanning = read(
      ".claude/skills/graph-workflow-planning/SKILL.md",
    );
    const cliSkill = read(
      "plugins/command-center/command-center/skills/cc-cli/SKILL.md",
    );

    expect(agents).toContain("cctl validate run test --wait");
    expect(agents).toContain("bun run test <specific test file paths>");
    expect(agents).toContain("bun run lint");
    expect(agents).toContain("bun run typecheck");
    expect(agents).toContain("Never bypass the wrapper");
    expect(agents).toContain("state the reason first");

    expect(agentContext).toContain("global cost budget");
    expect(agentContext).toContain("systemic capacity");

    expect(graphPlanning).toContain("scriptValidator.commands");
    expect(graphPlanning).toContain("agentValidation.implementer");
    expect(graphPlanning).toContain("agentValidation.contextValidator");
    expect(graphPlanning).toContain("laneMergeValidation");
    expect(graphPlanning).toContain("Implementer test access stays enabled");
    expect(graphPlanning).not.toContain("preMergeCommand");
    expect(localAgentGraphPlanning).toBe(graphPlanning);
    expect(localClaudeGraphPlanning).toBe(graphPlanning);

    expect(cliSkill).toContain("## cctl validate");
    expect(cliSkill.indexOf("## cctl validate")).toBeGreaterThan(
      cliSkill.indexOf("<!-- END GENERATED COMMAND REFERENCE -->"),
    );
  });

  it("teaches the spec-import workflow, boundaries, and conventions on both generated surfaces", () => {
    const importing = SPEC_GUIDANCE_SECTIONS.find(
      (section) => section.id === "importing",
    );

    // `shared` is what puts the section in the runtime block an agent working
    // outside this repository receives — the only surface it ever sees.
    expect(importing?.audience).toBe("shared");

    const heading = importing?.heading ?? "";
    expectImportSectionStatesItsContract(
      renderRuntimeSpecInstructions(),
      heading,
      SPEC_GUIDANCE_NEIGHBOUR_TOKEN,
      "the runtime /spec block",
    );
    // The committed document is generated from the same sections, so its
    // carrying the contract is the evidence it was regenerated after the edit.
    expectImportSectionStatesItsContract(
      read(".claude/commands/spec.md"),
      heading,
      SPEC_GUIDANCE_NEIGHBOUR_TOKEN,
      ".claude/commands/spec.md",
    );
  });

  /**
   * The plugin skill is loaded straight into a conversation, so it is the
   * surface an agent may read INSTEAD of the runtime block rather than after
   * it. Holding it to the same claim list is what makes the two unable to
   * drift: a claim dropped from the guidance module fails on the generated
   * surfaces, and the same claim dropped here fails on the skill.
   */
  it("keeps the native-sdd-authoring skill's import section aligned with the shared guidance", () => {
    expectImportSectionStatesItsContract(
      read(
        "plugins/command-center/command-center/skills/native-sdd-authoring/SKILL.md",
      ),
      SKILL_IMPORT_SECTION_HEADING,
      SKILL_NEIGHBOUR_TOKEN,
      "native-sdd-authoring SKILL.md",
    );
  });

  /**
   * The audited spec-import run ranked its own DB-resident spec #1 as
   * `external-readonly`, and the charter's permission gate then forbade every
   * validator from reading the contract it was judging against. A planner that
   * reads this skill and not the lint's refusal must still reach the readable
   * spelling, so the section states the reserved locator, the grade, and what
   * `external-readonly` is left for.
   */
  it("teaches the readable spelling of the plan's own spec source of truth", () => {
    const skill = read(
      "plugins/command-center/command-center/skills/native-sdd-authoring/SKILL.md",
    );
    const section = markdownSection(skill, SKILL_SOURCES_SECTION_HEADING);

    expect(
      section,
      `native-sdd-authoring SKILL.md has no "## ${SKILL_SOURCES_SECTION_HEADING}" section`,
    ).not.toBe("");
    // The slice really is one section: a neighbour-owned token the document
    // demonstrably carries is outside it.
    expect(section).not.toContain("## ");
    expect(collapse(skill)).toContain(SKILL_NEIGHBOUR_TOKEN);
    expect(section).not.toContain(SKILL_NEIGHBOUR_TOKEN);

    for (const claim of SPEC_SOURCE_GUIDANCE_CLAIMS) {
      expect(
        section,
        `native-sdd-authoring SKILL.md's sources-of-truth section is missing: ${claim}`,
      ).toContain(claim);
    }
  });

  /**
   * The audited spec-import run spent 55 minutes publishing seven
   * single-member lanes whose contexts were already edge-ordered into chains.
   * Nothing refused that plan — a placement-free plan is always legal — so the
   * only thing that reaches a planner is prose. This pins the decision rules a
   * planner needs BEFORE authoring, not the schema it can read afterwards.
   */
  it("teaches the plan tier's placement decision rules", () => {
    const skill = read(
      "plugins/command-center/command-center/skills/native-sdd-authoring/SKILL.md",
    );
    const section = markdownSection(skill, SKILL_PLACEMENT_SECTION_HEADING);

    expect(
      section,
      `native-sdd-authoring SKILL.md has no "## ${SKILL_PLACEMENT_SECTION_HEADING}" section`,
    ).not.toBe("");
    // The slice really is one section: a neighbour-owned token the document
    // demonstrably carries is outside it.
    expect(section).not.toContain("## ");
    expect(collapse(skill)).toContain(SKILL_NEIGHBOUR_TOKEN);
    expect(section).not.toContain(SKILL_NEIGHBOUR_TOKEN);

    for (const claim of SPEC_PLACEMENT_GUIDANCE_CLAIMS) {
      expect(
        section,
        `native-sdd-authoring SKILL.md's placement section is missing: ${claim}`,
      ).toContain(claim);
    }
  });

  it("names the placement field and its solo-lane default in the plan-edit help", () => {
    const entry = specHelpEntries.find(
      (candidate) => candidate.path.join(" ") === "spec plan edit",
    );
    expect(entry, "cctl has no `spec plan edit` help entry").toBeDefined();

    const slice = collapse(JSON.stringify(entry));
    expect(
      collapse(JSON.stringify(specHelpEntries)),
      "the spec help registry no longer contains the neighbour token this check is calibrated against",
    ).toContain(PLAN_EDIT_HELP_NEIGHBOUR_TOKEN);
    expect(
      slice,
      "the plan-edit help slice leaked into a neighbouring command's entry",
    ).not.toContain(PLAN_EDIT_HELP_NEIGHBOUR_TOKEN);

    for (const claim of PLAN_EDIT_HELP_CLAIMS) {
      expect(
        slice,
        `cctl spec plan edit --help is missing: ${claim}`,
      ).toContain(claim);
    }
  });

  it("keeps graph prompt validation guidance selection-aware", () => {
    const iterationPrompt = read("src/lib/workflow-graph/iteration-prompt.ts");
    const iterationOrchestrator = read(
      "src/lib/workflow-graph/iteration-orchestrator.ts",
    );
    const validatorRunner = read("src/lib/workflow-graph/validator-runner.ts");
    const section = read("src/lib/workflow-graph/validation-prompt-section.ts");

    // Both lane prompts compose the generated per-context section
    // (validation-concurrency §8) rather than hand-writing command guidance.
    expect(iterationPrompt).toContain("buildValidationCommandsSection");
    expect(validatorRunner).toContain("buildValidationCommandsSection");
    expect(validatorRunner).toContain(
      "buildValidatorDeterministicChecksGuidance",
    );
    // Both runners source the registry through the fail-visible loader: the
    // enabled set is the frozen seed snapshot, and a failed registry read
    // renders an explicit notice instead of dropping the section (§6/§8).
    expect(iterationOrchestrator).toContain("loadValidationPromptRegistry");
    expect(validatorRunner).toContain("loadValidationPromptRegistry");
    expect(section).toContain("could not be read");
    // The section carries the wrapper rule and the wait/queue guidance.
    expect(section).toContain("cctl validate run <name>");
    expect(section).toContain("re-run with `--wait`");
    expect(section).toContain(
      "No validation commands are disabled by policy in this context.",
    );
    expect(section).toContain("No script gate is selected for this context.");
    // §7 and the clean legacy cutover: the absent-gate wording attributes the
    // gap to workflow policy without reviving the removed pre-merge path.
    expect(section).toContain("workflow policy disables it");
    expect(section).not.toContain("pre-merge validation script");
    expect(section).not.toContain("legacy configuration");
    expect(iterationPrompt).not.toContain("validationSelections?:");
    expect(validatorRunner).not.toContain("validationSelections?:");
    expect(validatorRunner).not.toContain("pre-merge validation script");
  });

  /**
   * The planning skill ships twice — `.claude/skills` for Claude, `.agents/skills`
   * for Codex — and both are read by planning agents authoring the SAME plan
   * schema. Drift means one backend plans against a shape the other's CLI
   * refuses, which surfaces as a validation failure nobody can reproduce.
   */
  it("keeps both graph-workflow-planning skill copies byte-identical", () => {
    expect(read(".agents/skills/graph-workflow-planning/SKILL.md")).toBe(
      read(".claude/skills/graph-workflow-planning/SKILL.md"),
    );
  });

  it("teaches the three placement grades, ownership grain, and shared-surface sequencing", () => {
    const skill = read(".claude/skills/graph-workflow-planning/SKILL.md");

    // The authored field and its three grades, in the spelling a plan.json uses.
    expect(skill).toContain("## Lane Placement and File Ownership");
    expect(skill).toContain('"placement"');
    expect(skill).toContain('"mode": "readOnly"');
    expect(skill).toContain('"mode": "owned"');
    expect(skill).toContain('"mode": "full"');
    expect(skill).toContain('"ownedPaths"');

    // Selection judgment: what each grade is FOR.
    expect(skill).toContain("Same-file competition");
    expect(skill).toContain("Dependency-mutating");
    expect(skill).toContain("fan-out readers");

    // Ownership grain and the new-file denial it avoids.
    expect(skill).toContain("directory-grain ownership");
    expect(skill).toContain("### Sequencing shared surfaces");
    expect(skill).toContain("dependency-ordered");

    // Envelope consequences the planner has to plan AROUND.
    expect(skill).toContain("cannot commit, branch, or reset");
    expect(skill).toContain("Whole-repo verification runs once per lane");
    expect(skill).toContain("payload directory");
    expect(skill).toContain("per-context scratch");
    expect(skill).toContain("one worktree and one fan-in join");

    // The accept-time refusals, so a planner can read a validate failure.
    for (const code of [
      "placement-reserved-lane-name",
      "placement-session-lane-write-capable",
      "placement-lane-name-invalid",
      "placement-readonly-missing-output-schema",
      "placement-full-access-concurrency",
      "placement-owned-paths-overlap",
    ]) {
      expect(skill).toContain(code);
    }

    // The pre-placement guidance inverted the intra-lane rule: concurrent
    // same-lane members MUST be ownership-disjoint, so the old blanket
    // "never contort boundaries for disjointness" advice cannot survive.
    expect(skill).not.toContain(
      "do not contort context boundaries to keep write surfaces disjoint",
    );
    expect(skill).not.toContain("one branch per context");
  });

  it("documents the placement model and ownership envelope in the owning steering", () => {
    const workflows = read(".kiro/steering/workflows.md");
    const auditDataSources = read(
      ".claude/skills/graph-workflow-audit/references/data-sources.md",
    );

    expect(workflows).toContain("contextPlacementSchema");
    expect(workflows).toContain("placement-validation.ts");
    expect(workflows).toContain("ownedPaths");
    expect(workflows).toContain("ownership_violation");
    // The per-context landing model this replaced.
    expect(workflows).not.toContain(
      "Every provisioned worktree context is assigned an execution lane",
    );

    // The audit reference is the auditor's field map of a persisted execution.
    expect(auditDataSources).toContain("placement");
  });

  /**
   * `lanePlan` was the deterministic seed-time lane assignment, fully replaced
   * by authored `placement`. The sweep is over instruction surfaces rather than
   * the whole tree because those are the files an agent reads as current
   * instruction; legacy-persistence code and its migration fixtures keep the
   * field deliberately, since rows written before the cutover still carry it.
   */
  it("keeps the removed lanePlan vocabulary out of agent-facing guidance", () => {
    const allowlist = new Map<string, string>([
      [
        "docs/design/cc-cli/06-workflow-live-editing.md",
        "historical design record of the live-edit slice, which recomputed lanePlan",
      ],
      [
        "docs/reports/graph-workflow-improvement-report.md",
        "dated audit report describing the module set as it stood",
      ],
      [
        "docs/reports/graph-workflow-dynamic-improvements-report.md",
        "dated audit report describing the module set as it stood",
      ],
      [
        "docs/reports/2026-07-11-composable-modules-architecture-audit.md",
        "dated architecture audit citing lane-plan.ts line ranges",
      ],
    ]);
    const staleToken = /lanePlan|lane-plan/;

    const offenders = guidanceFilesContaining(staleToken).filter(
      (path) => !allowlist.has(path),
    );
    expect(offenders).toEqual([]);

    // An allowlist entry that no longer needs the exemption is a standing
    // licence to reintroduce the token, so every entry must still earn it.
    const deadEntries = [...allowlist.keys()].filter(
      (path) => !staleToken.test(read(path)),
    );
    expect(deadEntries).toEqual([]);
  });

  it("staffs workflow assignments from the library, not a runtime-only validator", () => {
    const skill = read(".claude/skills/graph-workflow-planning/SKILL.md");

    // The library is the discovery surface; a reference is never invented.
    expect(skill).toContain("cctl agent list");
    expect(skill).toContain("cctl agent get <tier:id>");
    // The cutover shapes, and the cascade rule that makes them replace whole.
    expect(skill).toContain('"assignments"');
    expect(skill).toContain("replace as **whole units**");
    // The pre-cutover singleton spellings must not survive anywhere.
    expect(skill).not.toContain('kind": "use"');
    expect(skill).not.toContain('kind": "disabled"');
  });
});
