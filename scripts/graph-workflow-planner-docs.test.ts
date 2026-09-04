import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allHelpEntries } from "../src/cli/help-registry";
import { pathKey } from "../src/cli/help-types";
import { renderCharterDigest } from "../src/lib/workflow-graph/charter/render";
import { graphWorkflowMutabilityPolicySchema } from "../src/lib/workflow-graph/config-schemas";
import {
  CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET,
  EXECUTION_TOTAL_PASS_BACKSTOP,
} from "../src/lib/workflow-graph/constants";
import {
  acceptanceCriteriaSchema,
  criterionRecordSchema,
  criterionRecordsOf,
} from "../src/lib/workflow-graph/criteria/criterion-records";
import {
  graphWorkflowContextEdgeSchema,
  graphWorkflowContextRoutingPolicySchema,
  graphWorkflowExecutionContextDefinitionSchema,
  graphWorkflowLoopGroupSchema,
  workflowBlockingValidatorResultSchema,
  workflowSemanticDefinitionSchema,
  workflowValidatorIssueSchema,
} from "../src/lib/workflow-graph/definition-schemas";
import { DELIVERY_PLAN_BINDING_LINT_ISSUE_CODES } from "../src/lib/specs/delivery-plan-binding-lint";
import { planRepairRoundSchema } from "../src/lib/workflow-graph/schemas";
import { EXPANSION_CAPS } from "../src/lib/workflow-graph/expansion-caps";
import { graphExpansionRequestSchema } from "../src/lib/workflow-graph/expansion-service";
import {
  LOOP_HISTORY_MAX_CONTEXT_BYTES,
  LOOP_HISTORY_MAX_PASSES,
  LOOP_HISTORY_MAX_SECTION_BYTES,
} from "../src/lib/workflow-graph/loop-history";
import { SEEDED_WORKFLOW_DEFAULTS } from "../src/lib/workflow-graph/resolve-config";
import { collectEnvelopedScriptCoverageIssues } from "../src/lib/workflow-graph/command-selector-validation";
import {
  charterInvariantSchema,
  sourceOfTruthSchema,
  workflowCharterSchema,
} from "../src/lib/workflows/charter-schemas";
import { conversationReadCommands } from "../src/lib/conversations/conversation-ref";
import {
  LINT_MESSAGE_PREFIX,
  lintPlanSemantics,
} from "../src/lib/workflows/plan-lints";
import {
  planReviewFindingsCommand,
  REVIEW_CHANGES_REQUESTED_UNACKNOWLEDGED_CODE,
} from "../src/lib/workflows/plan-review/status-schemas";

/**
 * The D4 R16.3 documentation contract. Two halves, both checked against the
 * shipped code rather than against a second copy of the prose: the planner docs
 * must TEACH the dynamic primitives, and every schema field name, engine bound,
 * and `cctl` verb they cite must EXIST at the tip. A rename or a cap change that
 * lands without a doc update fails here instead of misleading the next planner.
 *
 * The skill is a PACKAGE: a core SKILL.md covering the ordinary planning path,
 * plus read-on-demand reference files under `references/`. Content assertions
 * run over the whole package; the structural assertions keep the core small and
 * every reference discoverable from it.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * Every deployed copy of the planning skill. They are provisioned to different
 * agents (Claude Code, Codex, the shipped CC plugin), so guidance that lands in
 * one and not the others is guidance most of the fleet never sees.
 */
const SKILL_DIRS = [
  ".claude/skills/graph-workflow-planning",
  ".agents/skills/graph-workflow-planning",
  "plugins/command-center/command-center/skills/graph-workflow-planning",
] as const;

/**
 * The reviewer-facing sibling (ticket #69 change 5). Same three roots for the
 * same reason: a reviewer runs on whichever agent the operator reached for, and
 * a protocol that lands in one root is a protocol most reviews never apply.
 */
const REVIEW_SKILL_DIRS = [
  ".claude/skills/graph-workflow-review",
  ".agents/skills/graph-workflow-review",
  "plugins/command-center/command-center/skills/graph-workflow-review",
] as const;

/** Every deployed skill package, canonical copy first. */
const SKILL_PACKAGES = [SKILL_DIRS, REVIEW_SKILL_DIRS] as const;

const STEERING = ".kiro/steering/workflows.md";

/**
 * The core must stay a readable single pass over the ordinary planning path.
 * When new guidance pushes it past this cap, move a section into a reference
 * file instead of raising the number — regrowing a monolithic skill is the
 * documented failure mode this structure exists to prevent (ticket #69).
 */
const CORE_SKILL_MAX_LINES = 400;

function read(relativePath: string): string {
  return readFileSync(path.resolve(REPO_ROOT, relativePath), "utf8");
}

/** Relative markdown paths of one skill copy: the core plus its references. */
function skillFiles(dir: string): string[] {
  const referencesDir = path.resolve(REPO_ROOT, dir, "references");
  const references = existsSync(referencesDir)
    ? readdirSync(referencesDir)
        .filter((name) => name.endsWith(".md"))
        .sort()
        .map((name) => `references/${name}`)
    : [];
  return ["SKILL.md", ...references];
}

/** The whole package's prose, for assertions that may live in any file. */
function readPackage(dir: string): string {
  return skillFiles(dir)
    .map((file) => read(`${dir}/${file}`))
    .join("\n");
}

/**
 * `toContain` on a 25 KB document prints the whole document on failure, which
 * buries the one missing phrase. Assert on the boolean and carry the phrase in
 * the message instead.
 */
function expectDocuments(doc: string, phrase: string, why: string): void {
  expect(doc.includes(phrase), `${why} — missing: ${phrase}`).toBe(true);
}

function jsonExampleAfterHeading(markdown: string, heading: string): unknown {
  const headingIndex = markdown.indexOf(heading);
  if (headingIndex < 0) {
    throw new Error(`documentation example heading is missing: ${heading}`);
  }
  const match = markdown
    .slice(headingIndex + heading.length)
    .match(/```json\n([\s\S]*?)\n```/);
  if (!match?.[1]) {
    throw new Error(`documentation JSON example is missing after: ${heading}`);
  }
  return JSON.parse(match[1]);
}

function shapeKeys(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape);
}

/**
 * The one section that owns delivering a native spec (#80 design 3.6). It may
 * live in the core or in a reference file the core's table names; what it may
 * not do is live in both.
 */
const NATIVE_SPEC_DELIVERY_HEADING = "Delivering a native spec";

/** The files of one skill copy that declare the delivery heading. */
function nativeSpecDeliveryOwners(dir: string): string[] {
  const heading = new RegExp(
    `^#{1,4} ${NATIVE_SPEC_DELIVERY_HEADING}\\s*$`,
    "mu",
  );
  return skillFiles(dir).filter((file) => heading.test(read(`${dir}/${file}`)));
}

/** The canonical copy's delivery guidance, whichever file owns it. */
function nativeSpecDeliveryGuidance(): string {
  const dir = SKILL_DIRS[0];
  const owner = nativeSpecDeliveryOwners(dir)[0];
  if (owner === undefined) {
    throw new Error(
      `no file in ${dir} declares "${NATIVE_SPEC_DELIVERY_HEADING}"`,
    );
  }
  return read(`${dir}/${owner}`);
}

/**
 * Terms the skill must document, each paired with the shape that has to declare
 * it. The pairing is the point: asserting only that the word appears would pass
 * on a field the engine renamed a release ago.
 */
const DOCUMENTED_FIELDS: ReadonlyArray<{
  term: string;
  owner: string;
  keys: readonly string[];
}> = [
  {
    term: "when",
    owner: "graphWorkflowContextEdgeSchema",
    keys: shapeKeys(graphWorkflowContextEdgeSchema),
  },
  {
    term: "cardinality",
    owner: "graphWorkflowContextRoutingPolicySchema",
    keys: shapeKeys(graphWorkflowContextRoutingPolicySchema),
  },
  {
    term: "routing",
    owner: "graphWorkflowExecutionContextDefinitionSchema",
    keys: shapeKeys(graphWorkflowExecutionContextDefinitionSchema),
  },
  {
    term: "outputSchema",
    owner: "graphWorkflowExecutionContextDefinitionSchema",
    keys: shapeKeys(graphWorkflowExecutionContextDefinitionSchema),
  },
  {
    term: "bodyContextIds",
    owner: "graphWorkflowLoopGroupSchema",
    keys: shapeKeys(graphWorkflowLoopGroupSchema),
  },
  {
    term: "entryContextId",
    owner: "graphWorkflowLoopGroupSchema",
    keys: shapeKeys(graphWorkflowLoopGroupSchema),
  },
  {
    term: "exitContextId",
    owner: "graphWorkflowLoopGroupSchema",
    keys: shapeKeys(graphWorkflowLoopGroupSchema),
  },
  {
    term: "until",
    owner: "graphWorkflowLoopGroupSchema",
    keys: shapeKeys(graphWorkflowLoopGroupSchema),
  },
  {
    term: "maxPasses",
    owner: "graphWorkflowLoopGroupSchema",
    keys: shapeKeys(graphWorkflowLoopGroupSchema),
  },
  {
    term: "allowAgentContextAdd",
    owner: "graphWorkflowMutabilityPolicySchema",
    keys: shapeKeys(graphWorkflowMutabilityPolicySchema),
  },
  {
    term: "requestId",
    owner: "graphExpansionRequestSchema",
    keys: shapeKeys(graphExpansionRequestSchema),
  },
  {
    term: "rationale",
    owner: "graphExpansionRequestSchema",
    keys: shapeKeys(graphExpansionRequestSchema),
  },
  {
    term: "contextHandle",
    owner: "graphExpansionRequestSchema.tasks[]",
    keys: shapeKeys(graphExpansionRequestSchema.shape.tasks.element),
  },
  {
    term: "configFromContextId",
    owner: "graphExpansionRequestSchema.contexts[]",
    keys: shapeKeys(graphExpansionRequestSchema.shape.contexts.element),
  },
  {
    term: "acceptanceCriteria",
    owner: "graphExpansionRequestSchema.contexts[]",
    keys: shapeKeys(graphExpansionRequestSchema.shape.contexts.element),
  },
  {
    term: "appliesTo",
    owner: "charterInvariantSchema",
    keys: shapeKeys(charterInvariantSchema),
  },
  {
    term: "appliesTo",
    owner: "sourceOfTruthSchema",
    keys: shapeKeys(sourceOfTruthSchema),
  },
  {
    term: "statement",
    owner: "criterionRecordSchema",
    keys: shapeKeys(criterionRecordSchema),
  },
  {
    term: "planDefects",
    owner: "workflowBlockingValidatorResultSchema",
    keys: shapeKeys(workflowBlockingValidatorResultSchema),
  },
  {
    term: "parameters",
    owner: "workflowSemanticDefinitionSchema",
    keys: shapeKeys(workflowSemanticDefinitionSchema),
  },
  {
    term: "prerequisites",
    owner: "workflowSemanticDefinitionSchema",
    keys: shapeKeys(workflowSemanticDefinitionSchema),
  },
];

const REGISTRY_KEYS = new Set(
  allHelpEntries().map((entry) => pathKey(entry.path)),
);

/**
 * Pulls every `cctl …` invocation out of a markdown document's code spans and
 * fences, keeping only the leading verb path: words are consumed while the path
 * they build still prefixes a registered command, so ids, placeholders, and
 * flags terminate the scan without being mistaken for verbs.
 */
function citedCctlCommands(markdown: string): string[] {
  const prefixesACommand = (candidate: string): boolean => {
    for (const key of REGISTRY_KEYS) {
      if (key === candidate || key.startsWith(`${candidate} `)) return true;
    }
    return false;
  };

  const spans = markdown.match(/```[\s\S]*?```|`[^`\n]+`/g) ?? [];
  const found = new Set<string>();
  for (const span of spans) {
    for (const segment of span.split(/&&|\|\||[;|\n]/)) {
      const match = segment.match(/\bcctl\s+([a-z][\w\s-]*)/);
      if (!match) continue;
      let command = "";
      for (const word of (match[1] ?? "").split(/\s+/).filter(Boolean)) {
        if (!/^[a-z][a-z0-9-]*$/.test(word)) break;
        const next = command ? `${command} ${word}` : word;
        if (!prefixesACommand(next)) break;
        command = next;
      }
      if (command) found.add(command);
    }
  }
  return [...found];
}

/**
 * The exact invocations `cctl workflow review` prints for reaching the
 * reviewer's own conversation, built by the shipped helper with a placeholder
 * id. Both skills quote them, so a change to that vocabulary fails here rather
 * than leaving a planner a command that no longer exists.
 */
const REVIEWER_READ_COMMANDS = conversationReadCommands("<id>", "fresh").map(
  ([, command]) => command,
);

/**
 * One plan that crosses every semantic-lint threshold at once, run through the
 * shipped lint module. The ids and numbers the skill quotes are read back OUT
 * of these warnings rather than restated in this file, so a retuned threshold
 * or a renamed lint fails the doc assertion instead of leaving a planner a
 * stale number to plan against (ticket #69 change 6).
 */
function trippingPlanLintWarnings() {
  return lintPlanSemantics({
    charter: {
      sourcesOfTruth: [
        { id: "unreachable", locator: "https://example.com/design.md" },
      ],
    },
    executionContexts: [
      {
        id: "dense",
        description: "d".repeat(2100),
        acceptanceCriteria: [
          ...Array.from({ length: 12 }, (_, index) => ({
            id: `record-${index + 1}`,
            statement: `Obligation ${index + 1} holds.`,
          })),
          {
            id: "sweeping",
            statement: "The handler covers every call site.",
          },
          { id: "blob", statement: "x".repeat(700) },
        ],
      },
    ],
    tasks: [{ id: "oversized", instructions: "i".repeat(8100) }],
  });
}

describe("graph-workflow planner docs (D4 R16.3)", () => {
  it.each(SKILL_DIRS)(
    "%s documents guard, cardinality, and else authoring",
    (dir) => {
      const skill = readPackage(dir);
      const why = "guard authoring";

      expectDocuments(skill, "## Conditional Edges", why);
      // The guard wrapper and the else marker, in the exact shape the schema takes.
      expectDocuments(skill, '"when": { "schema"', why);
      expectDocuments(skill, '"when": { "else": true }', why);
      // Every cardinality value the policy admits, plus the halt it raises.
      for (const value of graphWorkflowContextRoutingPolicySchema.shape.cardinality.unwrap()
        .options) {
        expectDocuments(skill, `\`${value}\``, why);
      }
      expectDocuments(skill, "routing_cardinality", why);
      // Guards read a CAPTURED output, so the source must declare one.
      expectDocuments(skill, "guard-source-without-output-schema", why);
      expectDocuments(skill, "duplicate-else-edge", why);
    },
  );

  it.each(SKILL_DIRS)(
    "%s documents loop groups with a worker+judge body",
    (dir) => {
      const skill = readPackage(dir);
      const why = "loop authoring";

      expectDocuments(skill, "## Loop Groups", why);
      expectDocuments(skill, "worker", why);
      expectDocuments(skill, "judge", why);
      expectDocuments(skill, "single-entry", why);
      expectDocuments(skill, "single-exit", why);
      // Exhaustion halts; it never completes the loop (locked Q15).
      expectDocuments(skill, "loop_limit_reached", why);
      expectDocuments(
        skill,
        `${EXECUTION_TOTAL_PASS_BACKSTOP}-pass backstop`,
        why,
      );
      expectDocuments(skill, "loop-exit-without-output-schema", why);
      expectDocuments(skill, "non-reconverging-loop-branch", why);
    },
  );

  it.each(SKILL_DIRS)(
    "%s documents expansion authoring with the real caps",
    (dir) => {
      const skill = readPackage(dir);
      const why = "expansion authoring";

      expectDocuments(skill, "## Runtime Graph Expansion", why);
      expectDocuments(skill, "cctl workflow graph expand", why);
      // Half-static: the planner pre-declares the convergence point.
      expectDocuments(skill, "Generate-And-Filter", why);
      expectDocuments(
        skill,
        `${EXPANSION_CAPS.contextsPerRequest} contexts, ` +
          `${EXPANSION_CAPS.tasksPerRequest} tasks, ` +
          `${EXPANSION_CAPS.edgesPerRequest} edges, ` +
          `${EXPANSION_CAPS.canonicalPayloadBytes / 1024} KB`,
        why,
      );
      expectDocuments(
        skill,
        `${EXPANSION_CAPS.contextsPerAddingContext} generated contexts`,
        why,
      );
      expectDocuments(
        skill,
        `${EXPANSION_CAPS.contextsPerExecution} generated contexts`,
        why,
      );
    },
  );

  it.each(SKILL_DIRS)(
    "%s documents the handoff-field convention with a worked example",
    (dir) => {
      const skill = readPackage(dir);
      const why = "the handoff convention";

      // A worked example needs both halves of a worker+judge body: the schema
      // that carries the narrative, and the predicate that reads the verdict.
      expectDocuments(skill, '"handoff": {', why);
      expectDocuments(skill, '"until": { "schema"', why);
      // The Loop History bounds a planner sizes the handoff against.
      expectDocuments(skill, `${LOOP_HISTORY_MAX_PASSES} passes`, why);
      expectDocuments(
        skill,
        `${LOOP_HISTORY_MAX_CONTEXT_BYTES / 1024} KB per context`,
        why,
      );
      expectDocuments(
        skill,
        `${LOOP_HISTORY_MAX_SECTION_BYTES / 1024} KB per section`,
        why,
      );
    },
  );

  it.each(SKILL_DIRS)(
    "%s documents the plan-defect blocking response and the bound on it",
    (dir) => {
      const skill = readPackage(dir);
      const why = "the third blocking response";

      // The halt type, pinned to the enum plan repair accounts rounds under, so
      // a rename fails here instead of leaving planners a dead vocabulary.
      expect(
        planRepairRoundSchema.shape.haltType.options,
        "planRepairRoundSchema no longer admits `plan_defect`",
      ).toContain("plan_defect");
      expectDocuments(skill, "plan_defect", why);
      // The two properties that make this outcome different from a fail: it
      // reopens nothing, and repair answers it at first detection.
      expectDocuments(skill, "reopens no task", why);
      expectDocuments(skill, "first detection", why);
      // And the bound — without it the response reads as a way out of any
      // mandate a seat would rather not judge.
      expectDocuments(skill, "never a plan defect", why);
    },
  );

  it.each(SKILL_DIRS)(
    "%s documents the consecutive candidate-mismatch budget and its halt",
    (dir) => {
      const skill = readPackage(dir);
      const why = "the bound on rounds that never reach a verdict";

      // The halt type, pinned to the enum plan repair accounts rounds under, so
      // a rename fails here instead of leaving planners a dead vocabulary.
      expect(
        planRepairRoundSchema.shape.haltType.options,
        "planRepairRoundSchema no longer admits `candidate_unstable`",
      ).toContain("candidate_unstable");
      expectDocuments(skill, "candidate_unstable", why);
      // The number, from the engine constant rather than a second copy of it.
      expectDocuments(
        skill,
        `${CONSECUTIVE_CANDIDATE_MISMATCH_BUDGET} in a row`,
        why,
      );
      // And the planning lever, without which the halt reads as unactionable:
      // the churn is a placement problem, not a defect in the reviewed work.
      expectDocuments(skill, "does not share a worktree", why);
    },
  );

  it.each(SKILL_DIRS)(
    "%s scopes ownership lists to same-lane concurrency",
    (dir) => {
      const skill = readPackage(dir);
      const why = "the ownership-list scope rule";

      // `ownedPaths` exists to let unordered same-lane members race safely,
      // and nothing else. Both non-uses must be named — a sole member of a
      // lane and a member ordered against every lane-mate take `full` —
      // because a list where no race exists buys no parallelism and turns
      // unforeseen legitimate writes into `ownership_violation` halts.
      expectDocuments(
        skill,
        "concurrency mechanism, not a scoping mechanism",
        why,
      );
      expectDocuments(skill, "alone on its lane", why);
      expectDocuments(skill, "ordered against every lane-mate", why);
      // The validator rule that makes ordered `full` members legal, in the
      // shipped refusal vocabulary: disjointness binds only unordered pairs.
      expectDocuments(skill, "placement-full-access-concurrency", why);
      expectDocuments(skill, "may share paths freely", why);
    },
  );

  it.each(SKILL_DIRS)(
    "%s documents charter invariant scoping as the engine enforces it",
    (dir) => {
      const skill = readPackage(dir);
      const why = "invariant scoping";

      // The structured scope and its accept-time refusal: an invariant may name
      // the authored contexts it binds, and a scope naming an unknown context
      // is refused rather than silently never matching.
      expectDocuments(skill, "contextIds", why);
      expectDocuments(skill, "unknown-invariant-scope-context", why);
    },
  );

  it.each(SKILL_DIRS)(
    "%s documents acceptance criteria as the records the schema declares",
    (dir) => {
      const skill = readPackage(dir);
      const why = "acceptance-criteria records";

      // The record shape, taken from the schema rather than a second copy of
      // it: a rename fails here instead of teaching a spelling the accept path
      // refuses.
      expect(
        shapeKeys(criterionRecordSchema),
        "criterionRecordSchema no longer declares exactly { id, statement }",
      ).toEqual(["id", "statement"]);
      expectDocuments(skill, '"acceptanceCriteria": [', why);
      expectDocuments(skill, '"statement":', why);

      // One obligation per record is the whole point of the shape — without it
      // the records are a blob wearing a list's clothes.
      expectDocuments(skill, "one independently-failable obligation", why);

      // Prose stays a valid authored value and wraps as exactly ONE record
      // under the helper's deterministic id. The skill has to name the wrap so
      // a planner reads it as a migration affordance, not a second dialect.
      expect(
        acceptanceCriteriaSchema.safeParse("legacy prose").success,
        "the authored criteria union no longer accepts prose",
      ).toBe(true);
      const wrapped = criterionRecordsOf("legacy prose");
      expect(
        wrapped,
        "prose no longer wraps as exactly one criterion record",
      ).toHaveLength(1);
      for (const record of wrapped) {
        expectDocuments(skill, record.id, why);
      }

      // The citation the records exist for, pinned to the issue schema that
      // carries it.
      expect(
        shapeKeys(workflowValidatorIssueSchema),
        "workflowValidatorIssueSchema no longer carries `criterionId`",
      ).toContain("criterionId");
      expectDocuments(skill, "criterionId", why);
    },
  );

  it.each(SKILL_DIRS)(
    "%s documents charter source scoping and the retired access grade",
    (dir) => {
      const skill = readPackage(dir);
      const why = "charter source scoping";

      // Sources take the same structured scope invariants do, with the same
      // accept-time refusals — including the one that rejects the free-prose
      // spelling the engine cannot resolve against the graph.
      expect(
        shapeKeys(sourceOfTruthSchema),
        "sourceOfTruthSchema no longer declares `appliesTo`",
      ).toContain("appliesTo");
      expectDocuments(skill, "unknown-source-scope-context", why);
      expectDocuments(skill, "legacy-source-applies-to", why);

      // And they no longer take an access grade. The authored schema is the
      // contract: a field it refuses must not appear in guidance whose whole
      // job is telling a planner what to write.
      expect(
        shapeKeys(sourceOfTruthSchema),
        "sourceOfTruthSchema declares `accessPolicy` again — revisit the guidance",
      ).not.toContain("accessPolicy");
      for (const retired of ["accessPolicy", "external-readonly"]) {
        expect(
          skill.includes(retired),
          `the skill still teaches the retired \`${retired}\` source grade`,
        ).toBe(false);
      }
      // What replaced it: acquisition at plan time, not permission at run time.
      expectDocuments(skill, "materialize", why);
    },
  );

  it("pins the plan-time conflict rule to what the charter digest actually renders", () => {
    const skill = readPackage(SKILL_DIRS[0]);
    const why = "plan-time source-conflict resolution";

    const charter = workflowCharterSchema.parse({
      mission: "Ship the thing.",
      sourcesOfTruth: [
        {
          rank: 1,
          id: "global-source",
          label: "Global reference",
          type: "document",
          locator: "docs/design.md",
          description: "Governs every context.",
        },
        {
          rank: 2,
          id: "scoped-source",
          label: "Scoped reference",
          type: "spec",
          locator: "docs/persistence.md",
          description: "Governs the persistence context only.",
          appliesTo: { contextIds: ["persistence"] },
        },
      ],
    });

    // A scoped source renders for the context it names and for no other — the
    // filtering the skill tells planners to rely on when they scope.
    const scopedDigest = renderCharterDigest(charter, "persistence");
    expect(scopedDigest).toContain("Scoped reference");
    expect(renderCharterDigest(charter, "unrelated")).not.toContain(
      "Scoped reference",
    );

    // And no prompt carries a runtime precedence or deferral instruction any
    // more, which is why the resolution has to happen while planning.
    for (const retired of [
      "prevails",
      "higher-ranked",
      "Applying the source",
    ]) {
      expect(
        scopedDigest.includes(retired),
        `the charter digest still renders the retired precedence rule (${retired})`,
      ).toBe(false);
    }
    expectDocuments(skill, "resolved at plan time", why);
    expectDocuments(skill, "blocking plan-review finding", why);
  });

  it("documents charter field shapes through a schema-valid maximal example", () => {
    const core = read(`${SKILL_DIRS[0]}/SKILL.md`);
    const charter = workflowCharterSchema.parse(
      jsonExampleAfterHeading(core, "### Compact maximal charter example"),
    );

    expect(typeof charter.mission).toBe("string");
    expect(typeof charter.testStrategy).toBe("string");
    for (const field of [
      "conventions",
      "nonGoals",
      "vocabulary",
      "knownAmbiguities",
    ] as const) {
      expect(
        Array.isArray(charter[field]),
        `${field} must be a string array`,
      ).toBe(true);
      expect(charter[field]?.every((value) => typeof value === "string")).toBe(
        true,
      );
    }
    // The example invariant is outcome-shaped on purpose: invariants are
    // validator-checked, and a process rule there ("start with a failing
    // test") fails correct work for lacking proof (#80, FM-11). Process
    // guidance belongs in `conventions`, which the example also carries.
    expect(charter.invariants).toEqual([
      {
        id: "server-side-enforcement",
        statement: "Every gate is enforced server-side, never only in the UI.",
      },
    ]);
    expect(charter.conventions).toContain("Use red-green-refactor.");
    expect(charter.sourcesOfTruth).toEqual([
      {
        rank: 1,
        id: "runtime",
        label: "Workflow runtime",
        type: "code",
        locator: "src/lib/workflow-graph",
        description: "Governs runtime behavior.",
      },
    ]);
  });

  it("documents literal suppression, source resolution, warning lifetime, and mutability", () => {
    const skill = readPackage(SKILL_DIRS[0]);
    const why = "planner warning and mutability contracts";

    expect(SEEDED_WORKFLOW_DEFAULTS.mutability).toEqual({
      allowAgentTaskAdd: false,
      allowAgentContextAdd: false,
    });
    for (const phrase of [
      "Both mutability flags default to `false`",
      '{"allowAgentTaskAdd":true,"allowAgentContextAdd":false}',
      "Exact UI/output copy containing a quantifier must be syntactically quoted",
      "Suppression is match-local",
      "unmatched delimiters suppress nothing",
      "named verified resolution substrate",
      "recomputed for each response",
      "not saved rationale",
    ]) {
      expectDocuments(skill, phrase, why);
    }
  });

  it("documents lane visibility, forking, convergence, and payload delivery", () => {
    const placement = read(
      `${SKILL_DIRS[0]}/references/placement-and-parallelism.md`,
    );
    const why = "lane visibility semantics";

    for (const phrase of [
      "Same-lane landed work is visible immediately",
      "forks from its single upstream lane",
      "forks from the session branch",
      "`context_merge` before dispatch",
      "existing target lane",
      "multiple upstream lanes",
      "captured structured output payload",
      "no continuous synchronization",
      "different authoring session",
    ]) {
      expectDocuments(placement, phrase, why);
    }
  });

  it("documents the placement-mode script-gate matrix", () => {
    const validation = read(
      `${SKILL_DIRS[0]}/references/validation-and-staffing.md`,
    );
    const why = "placement-mode script validation";

    const cases: Array<{
      context: Parameters<
        typeof collectEnvelopedScriptCoverageIssues
      >[0]["context"];
      covered: boolean;
    }> = [
      {
        context: { id: "full", placement: { lane: "solo", mode: "full" } },
        covered: false,
      },
      {
        context: {
          id: "owned",
          placement: {
            lane: "shared",
            mode: "owned",
            ownedPaths: ["src/lib"],
          },
        },
        covered: true,
      },
      {
        context: {
          id: "read-only",
          placement: { lane: "session", mode: "readOnly" },
        },
        covered: true,
      },
    ];

    for (const { context, covered } of cases) {
      const issues = collectEnvelopedScriptCoverageIssues({
        context,
        commands: ["test"],
        commandField: "scriptValidator.commands",
        barrierCommands: [],
      });
      expect(issues.length > 0).toBe(covered);
    }

    for (const phrase of [
      "Placement mode—not lane member count—controls the context script gate",
      "single-member lane or an ordered shared lane",
      "before agent validation",
      "uncovered selected commands are refused",
      "leave repository gates to a downstream write-capable context",
      "The lane barrier is separate",
    ]) {
      expectDocuments(validation, phrase, why);
    }
  });

  it.each(SKILL_DIRS)(
    "%s documents launch parameters and the one-off run path",
    (dir) => {
      const skill = readPackage(dir);
      const why = "launch mechanics";

      // The only substitution token the lint admits, and both launch verbs.
      expectDocuments(skill, "{{inputs.", why);
      const cited = new Set(citedCctlCommands(readPackage(dir)));
      expect(cited, `${why} — \`cctl workflow run\` is not cited`).toContain(
        "workflow run",
      );
      expect(cited, `${why} — \`cctl workflow status\` is not cited`).toContain(
        "workflow status",
      );
    },
  );

  it.each(SKILL_DIRS)(
    "%s documents the semantic lints with the ids and dials the module emits",
    (dir) => {
      const skill = readPackage(dir);
      const why = "the warning-tier authoring lints";

      const ids = new Set<string>();
      const thresholds = new Set<string>();
      for (const warning of trippingPlanLintWarnings()) {
        expect(
          warning.message.startsWith(LINT_MESSAGE_PREFIX),
          `a semantic lint no longer prefixes its message with \`${LINT_MESSAGE_PREFIX}\``,
        ).toBe(true);
        ids.add(
          warning.message.slice(LINT_MESSAGE_PREFIX.length).split(":")[0] ?? "",
        );
        for (const [, threshold] of warning.message.matchAll(
          /\(more than (\d+)\)/g,
        )) {
          if (threshold !== undefined) thresholds.add(threshold);
        }
      }

      expect(
        [...ids].sort(),
        "the tripping plan no longer trips all four semantic lints",
      ).toEqual([
        "criteria-density",
        "open-quantifier",
        "oversized-prose",
        "source-locator-unresolvable",
      ]);

      // The stable id a planner reads off the warning line, prefix included:
      // that prefix is how advice is told from a structural warning.
      for (const id of ids) {
        expectDocuments(skill, `${LINT_MESSAGE_PREFIX}${id}`, why);
      }
      // And the dials themselves, quoted from the message a planner will see.
      expect(thresholds.size, "no lint reports a threshold any more").toBe(4);
      for (const threshold of thresholds) {
        expectDocuments(skill, threshold, `${why} — the documented dial`);
      }
      // Warning tier: a lint is answered, never a refusal to route around.
      expectDocuments(skill, "answered rather than ignored", why);
    },
  );

  it.each(SKILL_DIRS)(
    "%s documents the planner's half of plan review",
    (dir) => {
      const skill = readPackage(dir);
      const why = "the planner-facing review flow";

      // The reviewer's protocol lives in its own skill; this one points there.
      expectDocuments(skill, "graph-workflow-review", why);
      // Advisory first — absence of a review blocks nothing.
      expectDocuments(skill, "advisory and never required", why);
      // Status mode, spelled by the shipped command builder rather than by hand.
      expectDocuments(
        skill,
        planReviewFindingsCommand(".cc/temp/plan.json"),
        why,
      );
      // And how a fresh session reaches the reviewer's own deliberation.
      for (const command of REVIEWER_READ_COMMANDS) {
        expectDocuments(skill, command, `${why} — reviewer read commands`);
      }
      // The one blocking behavior, its refusal code, and both ways out.
      expectDocuments(skill, REVIEW_CHANGES_REQUESTED_UNACKNOWLEDGED_CODE, why);
      expectDocuments(skill, "--acknowledge-review", why);
      expectDocuments(skill, "invalidates the review", why);
    },
  );

  it.each(REVIEW_SKILL_DIRS)(
    "%s ships the reviewer skill as one thin file",
    (dir) => {
      expect(
        existsSync(path.resolve(REPO_ROOT, dir, "SKILL.md")),
        `${dir}/SKILL.md is missing — the reviewer skill ships to every deployed root`,
      ).toBe(true);
      expect(
        skillFiles(dir),
        `${dir} is no longer a single-file skill — the reviewer package is deliberately thin`,
      ).toEqual(["SKILL.md"]);
    },
  );

  it.each(REVIEW_SKILL_DIRS)(
    "%s carries the two-lens protocol and the terminal-only rule",
    (dir) => {
      const skill = read(`${dir}/SKILL.md`);
      const why = "the review protocol";

      // The completeness rubric is the planning skill's checklist, not a second
      // list this skill maintains.
      expectDocuments(skill, "graph-workflow-planning", why);
      expectDocuments(skill, "Before submitting, confirm", why);

      for (const finding of [
        "Missing outcome",
        "Dead handoff",
        "Uncovered requirement",
        "Overloaded context",
        "Misplaced obligation",
        "Contradictory phase",
        "Redundant criterion",
      ]) {
        expectDocuments(skill, finding, `${why} — lens vocabulary`);
      }

      // Repairs before additions: the one-sided completeness incentive that
      // inflated a real plan is exactly what this ordering corrects.
      expectDocuments(skill, "move, delete, defer, split", why);

      // A finding is located in the ids a verdict can cite, pinned to the issue
      // schema that carries one of them.
      expect(
        shapeKeys(workflowValidatorIssueSchema),
        "workflowValidatorIssueSchema no longer carries `criterionId`",
      ).toContain("criterionId");
      expectDocuments(skill, "criterionId", `${why} — finding location`);
      expectDocuments(skill, "contextId", `${why} — finding location`);

      // Terminal only: an aborted review records nothing at all.
      expectDocuments(skill, "Terminal verdicts only", why);
      expectDocuments(skill, "leaves NO record", why);
    },
  );

  it.each(REVIEW_SKILL_DIRS)(
    "%s documents record mode as the CLI implements it",
    (dir) => {
      const skill = read(`${dir}/SKILL.md`);
      const why = "the review verb";

      expect(
        new Set(citedCctlCommands(skill)),
        `${why} — \`cctl workflow review\` is not cited`,
      ).toContain("workflow review");

      // Every flag the shipped verb declares, taken from its help entry rather
      // than from a list this file maintains: a flag added or renamed there
      // fails here instead of leaving the reviewer a stale invocation.
      const entry = allHelpEntries().find(
        (candidate) => pathKey(candidate.path) === "workflow review",
      );
      expect(
        entry,
        "`cctl workflow review` has no help-registry entry",
      ).toBeDefined();
      for (const flag of entry?.flags ?? []) {
        expectDocuments(skill, `--${flag.name}`, `${why} — declared flags`);
        // The verdict flag's vocabulary is its placeholder: `approved|changes-requested`.
        const placeholder =
          flag.kind === "value" ? (flag.valuePlaceholder ?? "") : "";
        for (const value of placeholder.split("|")) {
          if (/^[a-z][a-z-]*$/.test(value)) {
            expectDocuments(skill, value, `${why} — ${flag.name} vocabulary`);
          }
        }
      }
      // Reviewer identity is captured from the reviewing conversation.
      expectDocuments(skill, "CC_CONVERSATION_ID", why);
      // Read mode hands the planner the way into that conversation.
      for (const command of REVIEWER_READ_COMMANDS) {
        expectDocuments(skill, command, `${why} — reviewer read commands`);
      }
      // Hash binding, and the gate the verdict feeds.
      expectDocuments(skill, "invalidates the review", why);
      expectDocuments(skill, REVIEW_CHANGES_REQUESTED_UNACKNOWLEDGED_CODE, why);
      expectDocuments(skill, "--acknowledge-review", why);
    },
  );

  it.each(SKILL_DIRS)(
    "%s only cites schema fields that exist at the tip",
    (dir) => {
      const skill = readPackage(dir);

      for (const { term, owner, keys } of DOCUMENTED_FIELDS) {
        expect(keys, `${owner} no longer declares \`${term}\``).toContain(term);
        expectDocuments(skill, term, `the ${owner} field \`${term}\``);
      }
    },
  );

  it.each([
    ...SKILL_PACKAGES.flatMap((dirs) => dirs.map((dir) => `${dir}/SKILL.md`)),
    STEERING,
  ])("%s only cites cctl commands the help registry resolves", (doc) => {
    const cited = citedCctlCommands(read(doc));

    expect(cited.length).toBeGreaterThan(0);
    for (const command of cited) {
      expect(
        REGISTRY_KEYS.has(command),
        `\`cctl ${command}\` is cited but has no help-registry entry`,
      ).toBe(true);
    }
  });

  it.each(
    SKILL_DIRS.flatMap((dir) =>
      skillFiles(dir)
        .filter((file) => file !== "SKILL.md")
        .map((file) => `${dir}/${file}`),
    ),
  )("%s only cites cctl commands the help registry resolves", (doc) => {
    for (const command of citedCctlCommands(read(doc))) {
      expect(
        REGISTRY_KEYS.has(command),
        `\`cctl ${command}\` is cited but has no help-registry entry`,
      ).toBe(true);
    }
  });

  it("cites the D4 lane and read verbs the primitives are driven through", () => {
    const cited = new Set(citedCctlCommands(readPackage(SKILL_DIRS[0])));

    expect(cited).toContain("workflow graph expand");
    expect(cited).toContain("workflow live ledger");
    expect(cited).toContain("workflow live edit");
  });

  /**
   * The native-spec delivery guidance (#80 design 3.6). Exactly one owner per
   * package: three prose copies of the same sequence is the drift this section
   * exists to end, and a second copy in a reference is the same defect wearing
   * a different filename.
   */
  it.each(SKILL_DIRS)(
    "%s owns the native-spec delivery guidance in exactly one file",
    (dir) => {
      const owners = nativeSpecDeliveryOwners(dir);

      expect(
        owners,
        `"${NATIVE_SPEC_DELIVERY_HEADING}" must be owned by exactly one file in ${dir} — found ${owners.length ? owners.join(", ") : "none"}`,
      ).toHaveLength(1);

      const owner = owners[0] ?? "";
      if (owner !== "SKILL.md") {
        expectDocuments(
          read(`${dir}/SKILL.md`),
          owner,
          "the read-on-demand reference index",
        );
      }
    },
  );

  /**
   * Bounded to what a receipt cannot teach. Everything else about the launch —
   * which command follows which — is the hint chain's job at the point of use,
   * and a copy here is a copy that goes stale silently.
   */
  it("bounds the native-spec delivery guidance to what a receipt cannot teach", () => {
    const guidance = nativeSpecDeliveryGuidance();
    const why = "the native-spec delivery guidance";

    // The two spec-specific concepts, as they exist at the tip.
    expectDocuments(guidance, "pinned revision", why);
    expectDocuments(guidance, "`binding`", why);
    expectDocuments(guidance, "claims", why);

    // Restate versus reference: spec criteria are the contract, context
    // criteria are the validator's checklist.
    expectDocuments(guidance, "never paste", why);

    // Phase-scoped authoring: the plan validates before any task exists.
    expectDocuments(guidance, "empty `tasks`", why);

    // Edge ids and the removal fallback.
    expectDocuments(guidance, "remove-edge", why);
    expectDocuments(guidance, "endpoint pair", why);

    // One line on the must-run constraint, pointing at the refusal that
    // carries the rationale. The code is read back out of the shipped lint so
    // a rename fails here rather than leaving a planner a dead code to grep.
    const mustRun = "binding/selected-criterion-not-must-run";
    expect(
      DELIVERY_PLAN_BINDING_LINT_ISSUE_CODES,
      "the must-run lint code was renamed",
    ).toContain(mustRun);
    expectDocuments(guidance, mustRun, why);
  });

  it("notes the covers follow-up in one sentence and instructs nothing about it", () => {
    const guidance = nativeSpecDeliveryGuidance();

    const mentions = guidance.match(/`covers`/gu) ?? [];
    expect(
      mentions.length,
      "the covers note is one sentence about a follow-up ticket, not guidance for a field this run does not ship",
    ).toBe(1);

    const sentence =
      guidance.replace(/\s+/gu, " ").match(/[^.]*`covers`[^.]*\./u)?.[0] ?? "";
    expect(sentence).toMatch(/follow-up ticket/u);
  });

  it("keeps the core SKILL.md a bounded single pass with discoverable references", () => {
    const core = read(`${SKILL_DIRS[0]}/SKILL.md`);
    const coreLines = core.split("\n").length;
    expect(
      coreLines,
      `SKILL.md is ${coreLines} lines (cap ${CORE_SKILL_MAX_LINES}) — move a section to references/ instead of growing the core`,
    ).toBeLessThanOrEqual(CORE_SKILL_MAX_LINES);

    // Progressive disclosure only works when the references exist and the core
    // names each one: a reference file SKILL.md never mentions is guidance no
    // planner will ever load.
    const references = skillFiles(SKILL_DIRS[0]).filter(
      (file) => file !== "SKILL.md",
    );
    expect(references.length).toBeGreaterThan(0);
    for (const reference of references) {
      expectDocuments(core, reference, "the read-on-demand reference index");
    }
  });

  it("keeps every skill package's copies in sync file by file", () => {
    for (const dirs of SKILL_PACKAGES) {
      const [canonicalDir, ...deployedDirs] = dirs;
      const canonicalFiles = skillFiles(canonicalDir);

      for (const dir of deployedDirs) {
        expect(skillFiles(dir), `${dir} ships a different file set`).toEqual(
          canonicalFiles,
        );
        for (const file of canonicalFiles) {
          expect(
            read(`${dir}/${file}`),
            `${dir}/${file} diverges from ${canonicalDir}/${file}`,
          ).toBe(read(`${canonicalDir}/${file}`));
        }
      }
    }
  });

  it("steering carries every cascade block, the D4 seeded defaults, and the new rows", () => {
    const steering = read(STEERING);

    // Cascade table: one row per block the cascade actually resolves.
    for (const block of Object.keys(SEEDED_WORKFLOW_DEFAULTS)) {
      expectDocuments(steering, `| \`${block}\` |`, "the cascade table");
    }
    // The D4 expansion-authority default, seeded off.
    expectDocuments(
      steering,
      '"allowAgentContextAdd": false',
      "the seeded defaults block",
    );

    // The per-context / per-definition D4 declarations that do NOT cascade.
    for (const declaration of ["outputSchema", "routing", "loopGroups"]) {
      expectDocuments(
        steering,
        declaration,
        "the non-cascading D4 declarations",
      );
    }

    // Adoption-matrix rows for the three modules D4 makes canonical.
    for (const canonicalModule of [
      "route-projection.ts",
      "expansion-service.ts",
      "loop-settlement.ts",
    ]) {
      expectDocuments(steering, canonicalModule, "the adoption matrix");
    }

    // The plan-defect outcome (ticket #69 change 1): the response a blocking
    // seat emits, and the halt it raises — steering is where an engine reader
    // learns that this one reopens nothing and routes straight to repair.
    for (const term of ["planDefects", "plan_defect"]) {
      expectDocuments(steering, term, "the plan-defect outcome");
    }

    // The staging seam and both of its repository-owned fences.
    for (const seam of [
      "prepareLiveExecutionEdits",
      "finalizePreparedEdits",
      "executionStateRevision",
      "structuralRevision",
    ]) {
      expectDocuments(steering, seam, "the staging-seam notes");
    }
  });
});
