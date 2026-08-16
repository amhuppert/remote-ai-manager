import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

import { AUTHORED_WORKFLOW_LAUNCH_ADMISSION_CALLERS } from "@/lib/workflow-graph/authored-launch-admission-callers";

/**
 * The cutover audit. Deleting an export is not retirement: a retired concept
 * survives as a re-export, a fixture, a CLI string, or a generated guidance
 * paragraph long after its module is gone. This scans the source tree for the
 * retired vocabulary itself and fails on the first surviving mention, so the
 * next agent cannot reintroduce one by copying a neighbouring file.
 *
 * It also holds the three structural promises the retirement rests on: native
 * SDD declares no mirror of graph structure, its proposal admits the launch
 * through the same service ordinary authoring uses, and its start reaches the
 * same one-off start core without minting a saved workflow definition. A
 * search that only proves the old names are gone would pass just as happily
 * against a freshly rebuilt mirror under new names.
 *
 * Every inventory here is declare-or-fail in both directions: a declared item
 * that is still reachable fails, and a declared item that was never real fails
 * too, so no list can rot into a set of vacuous assertions.
 */
const REPOSITORY_ROOT = path.resolve(__dirname, "../../..");
const SOURCE_ROOT = path.join(REPOSITORY_ROOT, "src");

/**
 * The legacy-aware boundary the design allows. Ledgered migrations are frozen
 * history: they created the artifacts the cutover removes, and rewriting them
 * would change what an already-upgraded database replayed. The applied
 * destructive migration reads the old shapes precisely so it can delete them.
 * Nothing else in `src/` may name that vocabulary.
 */
const LEGACY_AWARE_BOUNDARY = [
  "src/lib/state-store/migrations/0016-add-delivery-plan-candidates.ts",
  "src/lib/state-store/migrations/0019-delivery-plan-approval-identity.ts",
  "src/lib/state-store/migrations/0019-delivery-plan-approval-identity.test.ts",
  "src/lib/state-store/migrations/0026-delivery-plan-launch-cutover.ts",
  "src/lib/state-store/migrations/0026-delivery-plan-launch-cutover.test.ts",
  "src/lib/state-store/migrations/0028-retire-legacy-spec-executions.ts",
  "src/lib/state-store/migrations/0028-retire-legacy-spec-executions.test.ts",
  "src/lib/state-store/migrations/0030-native-sdd-v2-cutover.ts",
  "src/lib/state-store/migrations/0030-native-sdd-v2-cutover.test.ts",
  "src/lib/state-store/migrations/README.md",
  "src/lib/specs/native-sdd-cutover.arch.test.ts",
];

/**
 * The schema floor still has to recognize an unmigrated database well enough
 * to rebuild it, so it names the retired table and column it drops, and its
 * test has to seed exactly that legacy shape to prove the demolition. It is
 * open-time structural repair, not a reader: nothing here can return legacy
 * data to the application.
 */
const LEGACY_SHAPE_DEMOLITION = [
  "src/lib/state-store/state-db.ts",
  "src/lib/state-store/state-db.test.ts",
];

/**
 * Files that name the retired vocabulary only to assert its ABSENCE from
 * generated agent guidance. Exempting them keeps those regression pins alive;
 * they contain no reachable code path.
 */
const RETIREMENT_NEGATIVE_ASSERTIONS = [
  // Spells the retired dialect once, as the input the version-2 schema must
  // refuse. Without it nothing would prove the refusal is a schema floor
  // rather than an absence of callers.
  "src/lib/specs/delivery-plan.test.ts",
  "src/cli/help-registry.contract.test.ts",
  "src/cli/commands/spec/read.contract.test.ts",
  "src/cli/commands/spec/plan.help.test.ts",
  "src/lib/conversation-commands/native-spec-guidance.test.ts",
  "src/lib/agent-backends/codex/native-sdd-authoring-packaging.test.ts",
];

/** Modules and fixture directories the cutover deletes outright. */
const RETIRED_PATHS = [
  "src/lib/specs/group-contraction.ts",
  "src/lib/specs/group-contraction.test.ts",
  "src/lib/specs/legacy-import-fixtures",
  "src/lib/shared/testing/legacy-spec-compiler.ts",
  "src/lib/shared/testing/legacy-plan-render.ts",
  // The legacy graph execution contract: origin-prefix discrimination plus the
  // compiled-metadata dependency, grouping-freeze and predecessor rules it
  // decoded out of task metadata.
  "src/lib/shared/testing/spec-execution-contract-fixture.ts",
  // The criterion-modality proof producer / origin-map ingest pipeline.
  "src/lib/specs/evidence-producers.ts",
  "src/lib/specs/evidence-producers.test.ts",
  "src/lib/specs/evidence-ingest.ts",
  "src/lib/specs/evidence-ingest.test.ts",
  "src/lib/specs/execution-origin-map.ts",
  "src/lib/specs/execution-origin-map.test.ts",
  "src/lib/specs/self-committed-lane-evidence.integration.test.ts",
  // The version-1 delivery gate and the proof-closure suite that only it could
  // satisfy. `delivery-gate-v2.ts` is the sole gate.
  "src/lib/specs/delivery-gate.ts",
  "src/lib/specs/delivery-gate.test.ts",
  "src/lib/specs/candidate-proof-closure.integration.test.ts",
];

/**
 * Retired identifiers. Each is the *name* of a decision the direct-authored
 * design removed, not merely a helper that happened to move.
 */
const RETIRED_SYMBOLS = [
  // The SDD dialect itself: one schema per graph concept, which is what made
  // every graph addition an SDD parser change.
  "deliveryPlanContextSchema",
  "deliveryPlanContextTypeSchema",
  "deliveryPlanContextPlacementSchema",
  "deliveryPlanTaskSchema",
  "deliveryPlanEdgeSchema",
  "deliveryPlanWiringEntrySchema",
  "deliveryPlanWiringOwnerSchema",
  "deliveryPlanPolicyOverrideSchema",
  "deliveryPlanSourceOfTruthSchema",
  "deliveryPlanCharterInvariantSchema",
  "deliveryPlanGovernanceSchema",
  "deliveryPlanProofStepSchema",
  "emptyDeliveryPlanDocument",
  "DeliveryPlanContext",
  "DeliveryPlanTask",
  "DeliveryPlanEdge",
  "DeliveryPlanWiringEntry",
  "DeliveryPlanGovernance",
  "DeliveryPlanProofStep",
  "touchedSurfaces",
  // The SDD mirror of graph structure and its compiler.
  "contractTaskGroups",
  "contractedGroupsHavePath",
  "ContractedTaskGroup",
  "GroupContraction",
  "GRAPH_SHAPE_MINIMUM_TASKS",
  "OVERLOADED_TASK_CRITERION_SHARE",
  "legacy-spec-compiler",
  // Compiled candidate identity: a second artifact and a second hash.
  "compiledDefinitionHash",
  "compiled_definition_hash",
  "spec_delivery_plan_candidates",
  "SpecDeliveryPlanCandidateRow",
  "specDeliveryPlanCandidateRowSchema",
  "deliveryPlanCandidateIdentitySchema",
  "DeliveryPlanCandidateIdentity",
  "DeliveryPlanCandidateMismatchError",
  "DeliveryPlanApprovalIdentityMismatchError",
  "deliveryPlanApprovalSchema",
  "deliveryPlanPrelaunchSchema",
  "DeliveryPlanApproval",
  "DeliveryPlanPrelaunch",
  "deliveryPlanHash",
  "planHash",
  "plan_hash",
  "ProposeDeliveryPlanCandidate",
  "RecordDeliveryPlanTransitionInput",
  // Compiled provenance metadata smuggled through the graph.
  "specPlanSourceMap",
  "specPlanContextId",
  "proofPlan",
  // Origin-prefix runtime discrimination and the compiled task metadata the
  // legacy execution contract decoded out of an ordinary graph definition.
  "SPEC_EXECUTION_URI_PREFIX",
  "isLegacySpecExecution",
  "createSpecExecutionContract",
  "specTaskElementId",
  "specDependsOnTaskElementIds",
  "specCriterionElementIds",
  "specCriterionBriefs",
  // The criterion-modality proof producers.
  "EVIDENCE_PRODUCERS",
  "EvidenceProducerDefinition",
  "EvidenceSourceEvent",
  "evidenceProducerFor",
  "isEvidenceSourceEvent",
  "evidenceKindsForSourceEvent",
  "evidenceKindsForValidationEvent",
  "evidenceProducers",
  // The origin map that projected criteria onto graph contexts.
  "readSpecExecutionOriginMap",
  "SpecExecutionOriginMapEntry",
  "originMapFromExecutionBinding",
  "SpecExecutionBindingOrigin",
  "loadOriginMap",
  // The ingest pipeline that minted evidence and proof verdicts from graph
  // events, and every wiring name that reached it.
  "createEvidenceIngestService",
  "EvidenceIngestService",
  "EvidenceIngestDeps",
  "ingestAuthoritatively",
  "ingestBestEffort",
  "ingestExecutionEvidence",
  "ingestEvidenceBestEffort",
  "ingestExecutionEvidenceBestEffort",
  // The evidence write side: nothing mints evidence or proof verdicts, so a
  // task-completion claim could only ever refuse for want of ingested
  // evidence. `spec task`, its only surface, is already gone.
  "attachEvidence",
  "AttachEvidenceInput",
  "recordProofVerdict",
  "ProofVerdictInput",
  "ProofVerdictOrigin",
  "claimTaskComplete",
  "reopenTaskClaim",
  "TaskClaimInput",
  "TaskClaimContext",
  "getTaskClaimContext",
  // The pre-typed-binding execution correlation: the legacy binding column's
  // decoder, the persisted-definition lookup a saved start used to find the
  // spec side, and the session-scoped row correlation that adopted a run with
  // no binding. The typed link is the only authority now.
  "parseSpecExecutionBinding",
  "findExecutionAwaitingWorkflowByDefinitionIdInSession",
  "findExecutionByWorkflowExecutionIdInSession",
  // The scope-file hash the read-only legacy preview carried; active launch
  // identifies a run by its candidate, not by a hash of a selected scope.
  "hashExecutionScope",
  // The version-1 delivery gate.
  "createLegacyDeliveryGate",
  "LegacyDeliveryGateDeps",
  // Governance-owned validation selection; graph authoring owns it now.
  "validationCommandNames",
] as const;

/**
 * Native-SDD production source. Test fixtures are excluded because a fixture
 * is allowed to hand-build a graph document to feed the graph's own schema;
 * only shipped code is bound by the ownership boundary.
 */
const SPEC_PRODUCTION_ROOTS = [
  "src/lib/specs",
  "src/cli/commands/spec",
  "src/features/spec-studio",
] as const;

/** The graph modules that own the launch document's shape. */
const GRAPH_STRUCTURE_SCHEMA_MODULES = [
  "src/lib/workflow-graph/definition-schemas.ts",
  "src/lib/workflows/charter-schemas.ts",
];

/**
 * Field names whose presence in a native-SDD declaration means SDD has grown a
 * second opinion about graph structure. These are the shape of the launch
 * document, not merely its words: generic names the two domains legitimately
 * share (`id`, `name`, `kind`, `reason`, `tasks`) are deliberately absent, and
 * `keeps every scanned graph-structure field real` fails if any entry stops
 * being a graph field, so the list cannot drift into fiction.
 */
const GRAPH_STRUCTURE_FIELDS = [
  "acceptanceCriteria",
  "agentValidation",
  "approvalRequired",
  "askUserQuestions",
  "assignmentId",
  "bodyContextIds",
  "charter",
  "circuitBreaker",
  "collaboration",
  "contextPositions",
  "contextValidator",
  "edgeId",
  "edges",
  "entryContextId",
  "executionContexts",
  "exitContextId",
  "humanApprovalGate",
  "implementer",
  "invariants",
  "iterationPolicy",
  "laneMergeValidation",
  "layout",
  "lockedRegions",
  "loopGroups",
  "objective",
  "ownedPaths",
  "planRepair",
  "prerequisites",
  "routing",
  "scriptValidator",
  "scriptValidatorSource",
  "seedDefinitionId",
  "sourceContextId",
  "sourcesOfTruth",
  "targetContextId",
  "viewport",
  "workflowConfig",
] as const;

/**
 * The one declared collision. Studio's traceability view draws the spec's own
 * requirement/criterion/task lineage; its `edges` are spec elements, and it
 * never sees a launch. Declared rather than pattern-excused so a future
 * `edges` in delivery-plan code still fails.
 */
const GRAPH_STRUCTURE_FIELD_EXEMPTIONS = [
  {
    source: "src/features/spec-studio/SpecEvidenceLintTrace.tsx",
    field: "edges",
  },
] as const;

/**
 * The native-SDD modules allowed to name the graph launch schema. Each parses
 * or types a launch with the graph's own schema; none may declare its own.
 */
const SPEC_LAUNCH_SCHEMA_CONSUMERS = [
  "src/cli/commands/spec/write.ts",
  "src/lib/specs/delivery-plan-finalization.ts",
  "src/lib/specs/delivery-plan-seed.ts",
  "src/lib/specs/delivery-plan-service.ts",
  "src/lib/specs/delivery-plan-views.ts",
  "src/lib/specs/delivery-plan.ts",
  "src/lib/specs/execution-service.ts",
];

/**
 * Vocabulary that creates or updates a saved workflow definition. Spec start
 * launches a one-off: naming any of these inside native SDD would mean an
 * attempt had grown the persisted-definition intermediary back.
 */
const SAVED_DEFINITION_VOCABULARY = [
  "createWorkflowStorageService",
  "WorkflowDefinitionStoragePort",
  "ExecutionWorkflowDefinitions",
  "launchGraphWorkflowExecution",
  "startSaved",
  "saved-definition",
] as const;

/**
 * The one declared mention, and it is a refusal: a spec execution row carrying
 * a saved-definition seed source is corruption, so the summary reader names
 * that arm of the graph's union only to log and return null. Declared per site
 * so the same word anywhere else still fails.
 */
const SAVED_DEFINITION_REFUSALS: ReadonlyArray<{
  source: string;
  name: string;
}> = [];

/** The single graph start entry point native SDD is allowed to call. */
const SPEC_START_ENTRY_POINT = "launchSpecDeliveryGraphWorkflowExecution";

function repositoryFiles(relativeDirectory: string): string[] {
  const directory = path.join(REPOSITORY_ROOT, relativeDirectory);
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relativePath = path.posix.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) return repositoryFiles(relativePath);
    return entry.isFile() &&
      /\.(?:[cm]?tsx?|json|md)$/.test(entry.name) &&
      !entry.name.endsWith(".d.ts")
      ? [relativePath]
      : [];
  });
}

function specProductionFiles(): string[] {
  return SPEC_PRODUCTION_ROOTS.flatMap((root) => repositoryFiles(root)).filter(
    (relativePath) =>
      /\.tsx?$/.test(relativePath) &&
      !/\.(?:test|stories)\.tsx?$/.test(relativePath) &&
      !/(?:^|[./-])fixtures?\.tsx?$/.test(relativePath) &&
      !relativePath.endsWith("-test-fixture.ts"),
  );
}

function parse(relativePath: string, source: string): ts.SourceFile {
  return ts.createSourceFile(
    relativePath,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
}

function read(relativePath: string): string {
  return readFileSync(path.join(REPOSITORY_ROOT, relativePath), "utf8");
}

function declaredFieldNames(sourceFile: ts.SourceFile): string[] {
  const names: string[] = [];
  const record = (name: ts.PropertyName | undefined): void => {
    if (name === undefined) return;
    if (ts.isIdentifier(name) || ts.isStringLiteral(name))
      names.push(name.text);
  };
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "z" &&
      node.expression.name.text === "object" &&
      node.arguments[0] !== undefined &&
      ts.isObjectLiteralExpression(node.arguments[0])
    ) {
      for (const property of node.arguments[0].properties)
        record(property.name);
    }
    // A hand-written interface mirrors graph structure just as effectively as
    // a Zod schema does.
    if (ts.isPropertySignature(node)) record(node.name);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

/** Every `<name>(` call site in a source, regardless of receiver. */
function calledFunctionNames(sourceFile: ts.SourceFile): Set<string> {
  const called = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isIdentifier(node.expression)) called.add(node.expression.text);
      if (ts.isPropertyAccessExpression(node.expression)) {
        called.add(node.expression.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return called;
}

function graphMirrorOffenders(relativePath: string, source: string): string[] {
  const exempt = new Set<string>(
    GRAPH_STRUCTURE_FIELD_EXEMPTIONS.filter(
      (exemption) => exemption.source === relativePath,
    ).map((exemption) => exemption.field),
  );
  const structural = new Set<string>(GRAPH_STRUCTURE_FIELDS);
  return [
    ...new Set(
      declaredFieldNames(parse(relativePath, source)).filter(
        (name) => structural.has(name) && !exempt.has(name),
      ),
    ),
  ]
    .sort()
    .map((name) => `${relativePath} declares graph field ${name}`);
}

const EXEMPT_FILES = new Set([
  ...LEGACY_AWARE_BOUNDARY,
  ...LEGACY_SHAPE_DEMOLITION,
  ...RETIREMENT_NEGATIVE_ASSERTIONS,
]);

function auditedFiles(): string[] {
  return repositoryFiles("src").filter(
    (relativePath) => !EXEMPT_FILES.has(relativePath),
  );
}

describe("native SDD legacy retirement", () => {
  it("deleted every retired module and fixture directory", () => {
    const surviving = RETIRED_PATHS.filter((relativePath) =>
      existsSync(path.join(REPOSITORY_ROOT, relativePath)),
    );
    expect(
      surviving,
      `These paths are retired by the direct-authored cutover and must not exist:\n${surviving.join("\n")}`,
    ).toEqual([]);
  });

  it("leaves no retired symbol reachable outside the applied migration", () => {
    const offenders: string[] = [];
    for (const relativePath of auditedFiles()) {
      const source = readFileSync(
        path.join(REPOSITORY_ROOT, relativePath),
        "utf8",
      );
      for (const symbol of RETIRED_SYMBOLS) {
        // Word-bounded: `FinalizedDeliveryPlanApproval` is the surviving
        // name, not a surviving mention of the retired one.
        if (!new RegExp(`\\b${symbol}\\b`).test(source)) continue;
        offenders.push(`${relativePath} names ${symbol}`);
      }
    }
    expect(
      offenders,
      `Retired native-SDD vocabulary survives:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps every declared exemption real", () => {
    const missing = [...EXEMPT_FILES].filter(
      (relativePath) => !existsSync(path.join(REPOSITORY_ROOT, relativePath)),
    );
    expect(
      missing,
      `The audit exempts files that do not exist, so it proves nothing:\n${missing.join("\n")}`,
    ).toEqual([]);
    expect(existsSync(SOURCE_ROOT)).toBe(true);
  });
});

describe("no native SDD mirror of graph structure", () => {
  it("declares no schema or interface that restates graph structure", () => {
    const offenders = specProductionFiles().flatMap((relativePath) =>
      graphMirrorOffenders(relativePath, read(relativePath)),
    );
    expect(
      offenders,
      `Native SDD has grown a second opinion about graph structure. The launch belongs to the graph; import its schema instead of restating it:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("flags a planted mirror rather than trusting the current tree", () => {
    const planted = [
      "const deliveryPlanContextSchema = z.object({ contextId: z.string(), executionContexts: z.array(z.string()) });",
      "interface DeliveryPlanLayout { layout: { viewport: unknown } }",
    ].join("\n");
    expect(graphMirrorOffenders("src/lib/specs/planted.ts", planted)).toEqual([
      "src/lib/specs/planted.ts declares graph field executionContexts",
      "src/lib/specs/planted.ts declares graph field layout",
      "src/lib/specs/planted.ts declares graph field viewport",
    ]);
  });

  it("keeps every scanned graph-structure field real", () => {
    const graphFields = new Set(
      GRAPH_STRUCTURE_SCHEMA_MODULES.flatMap((relativePath) =>
        declaredFieldNames(parse(relativePath, read(relativePath))),
      ),
    );
    const fictional = GRAPH_STRUCTURE_FIELDS.filter(
      (field) => !graphFields.has(field),
    );
    expect(
      fictional,
      `These fields are scanned for as graph structure but the graph no longer declares them, so the scan proves nothing about them:\n${fictional.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps every declared field exemption real", () => {
    const stale = GRAPH_STRUCTURE_FIELD_EXEMPTIONS.filter((exemption) => {
      if (!existsSync(path.join(REPOSITORY_ROOT, exemption.source)))
        return true;
      return !declaredFieldNames(
        parse(exemption.source, read(exemption.source)),
      ).includes(exemption.field);
    });
    expect(
      stale,
      `These graph-field exemptions no longer apply and must be deleted:\n${stale.map((exemption) => `${exemption.source}:${exemption.field}`).join("\n")}`,
    ).toEqual([]);
  });

  it("declares every native-SDD module that names the graph launch schema", () => {
    const consumers = specProductionFiles().filter((relativePath) =>
      /\bworkflowDefinitionMutationSchema\b|\bWorkflowDefinitionMutation\b|\bWorkflowDefinitionDraft\b/.test(
        read(relativePath),
      ),
    );
    expect(consumers.sort()).toEqual([...SPEC_LAUNCH_SCHEMA_CONSUMERS].sort());
  });
});

describe("native SDD proposal shares the ordinary admission service", () => {
  it("registers spec proposal beside every ordinary authoring caller", () => {
    expect(
      Object.keys(AUTHORED_WORKFLOW_LAUNCH_ADMISSION_CALLERS).sort(),
    ).toEqual([
      "global-template-create",
      "global-template-edit",
      "global-template-replace",
      "global-template-validate",
      "project-create",
      "project-edit",
      "project-replace",
      "project-validate",
      "spec-proposal",
    ]);
    expect(AUTHORED_WORKFLOW_LAUNCH_ADMISSION_CALLERS["spec-proposal"]).toEqual(
      {
        documentScopes: ["project"],
        persists: true,
      },
    );
  });

  it("admits the spec launch through the shared service under that caller id", () => {
    const source = read("src/lib/specs/service-factory.ts");
    expect(source).toContain(
      'import { admitAuthoredWorkflowLaunch } from "@/lib/workflow-graph/authored-launch-admission"',
    );
    expect(source).toContain('caller: "spec-proposal"');
  });

  it("composes no project-bound graph validation of its own", () => {
    const offenders = specProductionFiles().flatMap((relativePath) => {
      const called = calledFunctionNames(
        parse(relativePath, read(relativePath)),
      );
      return [
        "validateWorkflowPlan",
        "createValidationCommandPreflight",
        "collectValidationCommandIssues",
        "checkWorkflowDefaults",
        "normalizeWorkflowDefinition",
      ]
        .filter((name) => called.has(name))
        .map((name) => `${relativePath} calls ${name}`);
    });
    expect(
      offenders,
      `Admission composition belongs to the shared service, not to native SDD:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

describe("native SDD start shares the spec-delivery start core", () => {
  it("binds the spec entry point to the shared manager's spec-delivery launch", () => {
    // The entry point is the route module's in-process seam, and its default
    // deps ride workflowManager.launchSpecDelivery — the same gauntlet every
    // other launch verb crosses. Spec code building its own start path would
    // bypass exactly this binding.
    const routeSource = read(
      "src/lib/workflow-graph/execution-route-handlers.ts",
    );
    expect(routeSource).toContain(
      `export async function ${SPEC_START_ENTRY_POINT}(`,
    );
    expect(routeSource.replace(/\s+/g, " ")).toContain(
      "launchSpecDeliveryExecution: (input) => workflowManager.launchSpecDelivery(input),",
    );
    const factorySource = read("src/lib/specs/service-factory.ts");
    expect(factorySource).toContain(
      `import { ${SPEC_START_ENTRY_POINT} } from "@/lib/workflow-graph/execution-route-handlers"`,
    );
  });

  it("reaches the graph only through that entry point", () => {
    const callers = specProductionFiles().filter((relativePath) =>
      calledFunctionNames(parse(relativePath, read(relativePath))).has(
        SPEC_START_ENTRY_POINT,
      ),
    );
    expect(callers).toEqual(["src/lib/specs/service-factory.ts"]);
  });

  it("names no vocabulary that could mint a saved workflow definition", () => {
    const refused = new Set(
      SAVED_DEFINITION_REFUSALS.map(
        (refusal) => `${refusal.source}:${refusal.name}`,
      ),
    );
    const offenders = specProductionFiles().flatMap((relativePath) => {
      const source = read(relativePath);
      return SAVED_DEFINITION_VOCABULARY.filter(
        (name) =>
          new RegExp(`\\b${name}\\b`).test(source) &&
          !refused.has(`${relativePath}:${name}`),
      ).map((name) => `${relativePath} names ${name}`);
    });
    expect(
      offenders,
      `Spec start launches a one-off; the persisted-definition intermediary is retired:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("keeps every declared saved-definition refusal real", () => {
    const stale = SAVED_DEFINITION_REFUSALS.filter(
      (refusal) =>
        !existsSync(path.join(REPOSITORY_ROOT, refusal.source)) ||
        !new RegExp(`\\b${refusal.name}\\b`).test(read(refusal.source)),
    );
    expect(
      stale,
      `These saved-definition refusals no longer exist, so exempting them proves nothing:\n${stale.map((refusal) => `${refusal.source}:${refusal.name}`).join("\n")}`,
    ).toEqual([]);
  });
});
