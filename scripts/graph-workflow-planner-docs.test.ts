import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allHelpEntries } from "../src/cli/help-registry";
import { pathKey } from "../src/cli/help-types";
import { graphWorkflowMutabilityPolicySchema } from "../src/lib/workflow-graph/config-schemas";
import { EXECUTION_TOTAL_PASS_BACKSTOP } from "../src/lib/workflow-graph/constants";
import {
  graphWorkflowContextEdgeSchema,
  graphWorkflowContextRoutingPolicySchema,
  graphWorkflowExecutionContextDefinitionSchema,
  graphWorkflowLoopGroupSchema,
  workflowBlockingValidatorResultSchema,
  workflowSemanticDefinitionSchema,
} from "../src/lib/workflow-graph/definition-schemas";
import { planRepairRoundSchema } from "../src/lib/workflow-graph/schemas";
import { EXPANSION_CAPS } from "../src/lib/workflow-graph/expansion-caps";
import { graphExpansionRequestSchema } from "../src/lib/workflow-graph/expansion-service";
import {
  LOOP_HISTORY_MAX_CONTEXT_BYTES,
  LOOP_HISTORY_MAX_PASSES,
  LOOP_HISTORY_MAX_SECTION_BYTES,
} from "../src/lib/workflow-graph/loop-history";
import { SEEDED_WORKFLOW_DEFAULTS } from "../src/lib/workflow-graph/resolve-config";
import { charterInvariantSchema } from "../src/lib/workflows/charter-schemas";

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

function shapeKeys(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape);
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
    "%s only cites schema fields that exist at the tip",
    (dir) => {
      const skill = readPackage(dir);

      for (const { term, owner, keys } of DOCUMENTED_FIELDS) {
        expect(keys, `${owner} no longer declares \`${term}\``).toContain(term);
        expectDocuments(skill, term, `the ${owner} field \`${term}\``);
      }
    },
  );

  it.each([...SKILL_DIRS.map((dir) => `${dir}/SKILL.md`), STEERING])(
    "%s only cites cctl commands the help registry resolves",
    (doc) => {
      const cited = citedCctlCommands(read(doc));

      expect(cited.length).toBeGreaterThan(0);
      for (const command of cited) {
        expect(
          REGISTRY_KEYS.has(command),
          `\`cctl ${command}\` is cited but has no help-registry entry`,
        ).toBe(true);
      }
    },
  );

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

  it("keeps the skill copies in sync file by file", () => {
    const canonicalFiles = skillFiles(SKILL_DIRS[0]);

    for (const dir of SKILL_DIRS.slice(1)) {
      expect(skillFiles(dir), `${dir} ships a different file set`).toEqual(
        canonicalFiles,
      );
      for (const file of canonicalFiles) {
        expect(
          read(`${dir}/${file}`),
          `${dir}/${file} diverges from ${SKILL_DIRS[0]}/${file}`,
        ).toBe(read(`${SKILL_DIRS[0]}/${file}`));
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
