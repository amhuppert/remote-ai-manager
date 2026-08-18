import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

vi.mock("@/lib/logging", () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { workflowDefinitionRecordSchema } from "@/lib/workflow-graph/definition-schemas";
import type {
  WorkflowDefinitionRecord,
  WorkflowSemanticDefinition,
} from "@/lib/workflow-graph/definition-schemas";
import { makeTestCharter } from "@/lib/shared/testing/charter-fixture";
import { createAgentProfileLibraryService } from "@/lib/agent-profiles/library-service";
import { createAgentProfileStorage } from "@/lib/agent-profiles/storage";
import { createAssignmentReferenceChecker } from "./assignment-references";
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { createWorkflowStorageService } from "./storage";

const PROJECT_PATH = "/durability-project";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "cc-workflow-storage-contract-"));

  // Every profile the maximal fixtures reference must exist: accept-time
  // validation resolves assignment references, so a fixture naming a profile
  // nobody created would be refused before durability is ever exercised.
  const library = createAgentProfileLibraryService({
    storage: createAgentProfileStorage({ resolveConfigDir: () => tempDir }),
  });
  for (const [tier, id] of [
    ["project", "persistence-implementer"],
    ["project", "security-reviewer"],
    ["global", "perf-reviewer"],
    ["global", "org-implementer"],
    ["global", "org-security"],
  ] as const) {
    await library.create({
      projectPath: PROJECT_PATH,
      tier,
      id,
      name: id,
      description: `Fixture profile ${tier}:${id}`,
      instructions: `Fixture instructions for ${tier}:${id}.`,
    });
  }
});

function storageForContract() {
  return createWorkflowStorageService({
    resolveConfigDir: () => tempDir,
    assignmentReferences: createAssignmentReferenceChecker({
      library: createAgentProfileLibraryService({
        storage: createAgentProfileStorage({ resolveConfigDir: () => tempDir }),
      }),
    }),
  });
}

/**
 * The maximal definition with every project-tier reference swapped for a
 * global-tier one. A global template is refused when it reaches into a project
 * (R4.2), so the global-scope round trip needs a document that is legal at that
 * scope while keeping every other maximal field intact.
 */
function buildGlobalScopeMaximalDefinition(): WorkflowSemanticDefinition {
  const definition = buildMaximalDefinition();
  return JSON.parse(
    JSON.stringify(definition)
      .replaceAll(
        '"tier":"project","id":"persistence-implementer"',
        '"tier":"global","id":"org-implementer"',
      )
      .replaceAll(
        '"tier":"project","id":"security-reviewer"',
        '"tier":"global","id":"org-security"',
      ),
  ) as WorkflowSemanticDefinition;
}

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

/**
 * A maximal {@link WorkflowSemanticDefinition} in which EVERY introspectable
 * persisted key path carries a distinctive non-default value, so the
 * schema-driven durability harness descends into every nested field — including
 * the full charter (`definition.charter.*`), every workflow-level config
 * override block, and one fully-populated execution context / task / edge.
 *
 * `schemaVersion` is set to a non-default `2` so the completeness guard accepts
 * it (the storage service stores `definition` verbatim, so the value survives).
 * The single context/task/edge keep the graph acyclic and self-consistent so
 * `validateWorkflowDefinition` (run inside `storage.create`) accepts it.
 */
function buildMaximalDefinition(): WorkflowSemanticDefinition {
  return {
    schemaVersion: 2,
    approvalRequired: true,
    origin: {
      sourceUri: "workflow-source:maximal/revision/2",
      label: "Maximal workflow source",
    },
    lockedRegions: [
      {
        paths: ["/tasks/task-1/instructions"],
        sourceUri: "workflow-source:maximal/revision/2",
        reason: "Task instructions come from the source workflow",
        instruction:
          "Amend workflow-source:maximal/revision/2 and recompile the definition.",
      },
    ],
    workflowConfig: {
      implementer: {
        id: "implementer",
        profile: { tier: "builtin", id: "general-implementer" },
        focus: "workflow-tier implementer steer",
        agent: {
          backend: "claude",
          model: "opus",
          reasoningEffort: "high",
        },
      },
      contextValidator: {
        enabled: false,
        assignments: [
          {
            id: "general",
            profile: { tier: "builtin", id: "general-reviewer" },
            focus: "workflow-tier steer",
            strategy: "conversation",
            authority: "blocking",
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
            continuity: { enabled: false, contextLimitTokens: 110_000 },
          },
        ],
      },
      scriptValidator: { commands: ["typecheck", "test"] },
      iterationPolicy: {
        maxIterations: 9,
        continuity: { enabled: false, contextLimitTokens: 80_000 },
      },
      circuitBreaker: { consecutiveFailureThreshold: 4 },
      mutability: { allowAgentTaskAdd: true, allowAgentContextAdd: true },
      planRepair: {
        enabled: false,
        maxAttemptsPerContext: 3,
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      },
      collaboration: {
        enabled: true,
        secondAgent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "low",
        },
        negotiationRounds: 3,
        autonomousResolutionThreshold: "major",
      },
      humanApprovalGate: { enabled: true },
      askUserQuestions: { enabled: true },
      agentValidation: {
        implementer: { mode: "all", except: ["format"] },
        contextValidator: { mode: "only", commands: ["test"] },
      },
      laneMergeValidation: {
        strategy: "every-merge",
        commands: { mode: "only", commands: ["typecheck"] },
      },
    },
    charter: makeTestCharter({
      invariants: [
        {
          id: "durable-scope",
          statement: "The durable contexts retain their scoped invariant.",
          appliesTo: { contextIds: ["ctx-1", "ctx-loop-worker"] },
        },
      ],
      // Authored-shaped sources: create is an accept path, so the legacy
      // shapes (prose appliesTo, retired accessPolicy) are refused here — their
      // read-tolerance durability is proven against a stored record instead.
      // The structured source scope is itself a persisted field this contract
      // must round-trip.
      sourcesOfTruth: [
        {
          rank: 1,
          id: "design-doc",
          label: "Approved design document",
          type: "document",
          locator: ".kiro/specs/workflow-charter/design.md",
          description: "The authoritative architecture for this workflow",
          appliesTo: { contextIds: ["ctx-1"] },
        },
        {
          rank: 2,
          id: "scoped-reference",
          label: "Scoped durable reference",
          type: "spec",
          locator: "docs/scoped-reference.md",
          description: "A reference scoped to the durable contexts.",
          appliesTo: { contextIds: ["ctx-1", "ctx-loop-worker"] },
        },
      ],
    }),
    parameters: [
      {
        type: "string",
        name: "feature-name",
        label: "Feature name",
        required: true,
        default: "widget",
        minLength: 1,
        maxLength: 64,
      },
      {
        type: "text",
        name: "design-notes",
        label: "Design notes",
        required: false,
        default: "first line\nsecond line",
        minLength: 0,
        maxLength: 4000,
      },
      {
        type: "enum",
        name: "priority",
        label: "Priority",
        required: true,
        options: ["low", "medium", "high"],
        default: "medium",
      },
    ],
    prerequisites: [
      { kind: "path", path: ".kiro/specs", label: "Kiro specs directory" },
      { kind: "skill", skill: "kiro-spec-design", backend: "claude" },
      { kind: "skill", skill: "kiro:spec-init" },
    ],
    executionContexts: [
      {
        id: "ctx-1",
        title: "Implement the thing",
        description: "Detailed description of the context",
        acceptanceCriteria: "All tests pass and the build is green",
        placement: { lane: "ctx-1", mode: "full" },
        origin: {
          sourceUri: "workflow-source:maximal/context/ctx-1",
          label: "Maximal context source",
        },
        // Authored annotations, opaque to storage but persisted with the
        // definition: an author may hang arbitrary keys here, so a dropped
        // column would silently strand them.
        metadata: {
          authoredAnnotationKey: "ctx-authored",
          authoredAnnotationPayload: "{}",
        },
        implementer: {
          id: "context-implementer",
          profile: { tier: "project", id: "persistence-implementer" },
          focus: "context-tier implementer steer",
          agent: {
            backend: "claude",
            model: "opus",
            reasoningEffort: "high",
          },
        },
        // Disabled with assignments intact: the dormant entries — their
        // profiles, focus, strategy, per-assignment continuity, and runtime —
        // must survive the round trip, or re-enabling would silently lose the
        // configured reviewers (R1.1, R2).
        contextValidator: {
          enabled: false,
          assignments: [
            {
              id: "security",
              profile: { tier: "project", id: "security-reviewer" },
              focus: "auth boundaries and token handling",
              strategy: "conversation",
              authority: "blocking",
              agent: {
                backend: "claude",
                model: "sonnet",
                reasoningEffort: "medium",
              },
              continuity: { enabled: false, contextLimitTokens: 120_000 },
            },
            {
              id: "performance",
              profile: { tier: "global", id: "perf-reviewer" },
              focus: "hot paths only",
              strategy: "task",
              authority: "blocking",
              agent: {
                backend: "codex",
                model: "gpt-5.4",
                reasoningEffort: "high",
              },
              continuity: { enabled: true, contextLimitTokens: 60_000 },
            },
          ],
        },
        scriptValidator: { commands: ["typecheck"] },
        mutability: { allowAgentTaskAdd: true, allowAgentContextAdd: true },
        circuitBreaker: { consecutiveFailureThreshold: 5 },
        iterationPolicy: {
          maxIterations: 7,
          continuity: { enabled: false, contextLimitTokens: 90_000 },
        },
        planRepair: {
          enabled: false,
          maxAttemptsPerContext: 4,
          agent: {
            backend: "claude",
            model: "opus",
            reasoningEffort: "low",
          },
        },
        collaboration: {
          enabled: true,
          secondAgent: {
            backend: "claude",
            model: "opus",
            reasoningEffort: "high",
          },
          negotiationRounds: 2,
          autonomousResolutionThreshold: "minor",
        },
        humanApprovalGate: { enabled: true },
        askUserQuestions: { enabled: true },
        agentValidation: {
          implementer: { mode: "only", commands: ["typecheck", "test"] },
          contextValidator: { mode: "all", except: ["format"] },
        },
        // `taskValidation` is a removed CC config field name reused here as an
        // ordinary output property: the cutover guard runs on every definition
        // read, so this pins the outputSchema subtree as opaque to it.
        outputSchema: {
          type: "object",
          properties: {
            verdict: { type: "string", enum: ["pass", "fail"] },
            taskValidation: { type: "string" },
            findings: { type: "array", items: { type: "string" } },
          },
          required: ["verdict"],
          additionalProperties: false,
        },
        // Source of the guarded edge below, so its cardinality policy is the one
        // D4 routing actually evaluates.
        routing: { cardinality: "exactlyOne" },
      },
      // A second context exists only as the edge target so the single
      // representative edge can connect two distinct contexts (a self-loop
      // would register as a cycle). The harness descends into the first context
      // and the first edge only, so this one stays minimal.
      {
        id: "ctx-2",
        title: "Downstream context",
        acceptanceCriteria: "Downstream criteria satisfied",
        placement: { lane: "ctx-2", mode: "full" },
      },
      // A worker + independent-judge loop body. Both contexts stay minimal
      // apart from the judge's outputSchema, which the loop's `until` predicate
      // below is validated against at accept time.
      {
        id: "ctx-loop-worker",
        title: "Loop worker",
        acceptanceCriteria: "Worker produced a revision",
        placement: { lane: "ctx-loop-worker", mode: "full" },
      },
      {
        id: "ctx-loop-judge",
        title: "Loop judge",
        acceptanceCriteria: "Judge recorded a verdict",
        placement: { lane: "ctx-loop-judge", mode: "full" },
        outputSchema: {
          type: "object",
          properties: { verdict: { type: "string", enum: ["pass", "fail"] } },
          required: ["verdict"],
          additionalProperties: false,
        },
      },
    ],
    tasks: [
      {
        id: "task-1",
        contextId: "ctx-1",
        order: 1,
        title: "First task",
        instructions: "Do the first thing carefully",
        metadata: { area: "backend" },
        source: "agent",
      },
    ],
    edges: [
      {
        id: "edge-1",
        sourceContextId: "ctx-1",
        targetContextId: "ctx-2",
        // A D4 activation guard over `ctx-1`'s declared output above: subset-
        // valid and statically compatible with it, so this fixture is a shape
        // the accept-time gate admits rather than merely one Zod parses.
        when: {
          schema: {
            type: "object",
            properties: { verdict: { const: "pass" } },
            required: ["verdict"],
          },
        },
      },
      {
        id: "edge-2",
        sourceContextId: "ctx-2",
        targetContextId: "ctx-loop-worker",
      },
      {
        id: "edge-3",
        sourceContextId: "ctx-loop-worker",
        targetContextId: "ctx-loop-judge",
      },
    ],
    loopGroups: [
      {
        id: "loop-1",
        title: "Refine until the judge passes",
        bodyContextIds: ["ctx-loop-worker", "ctx-loop-judge"],
        entryContextId: "ctx-loop-worker",
        exitContextId: "ctx-loop-judge",
        // Subset-valid and statically compatible with the judge's declared
        // output above, so this is a shape the accept-time gate admits rather
        // than merely one Zod parses.
        until: {
          schema: {
            type: "object",
            properties: { verdict: { const: "pass" } },
            required: ["verdict"],
          },
        },
        maxPasses: 3,
      },
    ],
  };
}

/**
 * Build a maximal {@link WorkflowDefinitionRecord} whose `definition` is the
 * maximal charter-bearing definition above. The harness compares against the
 * record the storage service actually returns from `create`, so the
 * writer-derived fields (`id`, `revision`, `createdAt`, `updatedAt`,
 * `layout.workflowId`) are sourced from that created record rather than this
 * fixture; this fixture only has to satisfy the completeness guard.
 */
function buildMaximalRecord(
  definition: WorkflowSemanticDefinition = buildMaximalDefinition(),
): WorkflowDefinitionRecord {
  return {
    id: "placeholder-id",
    name: "Maximal durable workflow",
    description: "A fully-populated definition record for the durability check",
    schemaVersion: 1,
    revision: 1,
    definition,
    layout: {
      workflowId: "placeholder-id",
      contextPositions: { "ctx-1": { x: 12, y: 34 } },
      viewport: { x: 5, y: 6, zoom: 1.5 },
    },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("workflow-graph storage durability contract", () => {
  it("round-trips every persisted definition key path — including the full charter — through the real storage service", async () => {
    const storage = storageForContract();

    await assertRoundTripDurability({
      label: "workflow-definition-storage",
      schema: workflowDefinitionRecordSchema,
      buildMaximalFixture: buildMaximalRecord,
      persist: async (fixture) => {
        // create() generates id/revision/createdAt/updatedAt and pins
        // layout.workflowId, so the record it returns is the authoritative
        // persisted value the reload must match. Return it as `expected`.
        return storage.create(
          { kind: "project", projectPath: PROJECT_PATH },
          {
            name: fixture.name,
            description: fixture.description,
            definition: fixture.definition,
            layout: fixture.layout,
          },
        );
      },
      reload: (expected) =>
        storage.get(
          { kind: "project", projectPath: PROJECT_PATH },
          expected.id,
        ),
      fieldPolicies: {
        // `schemaVersion` is a writer-pinned storage-format constant: create()
        // always sets it to 1, which is also the schema default. The harness
        // rejects "left at schema default" on a persisted path, so it cannot be
        // checked for non-default presence — but it is not a domain field whose
        // loss would matter (it is a format tag the writer reasserts on every
        // write). Excluding it from the contract is correct, not a gap.
        schemaVersion: "not-persisted",
        // id/createdAt/updatedAt are generated by create() (UUID + ISO
        // timestamps) and layout.workflowId is pinned to the generated id, so
        // none can be populated non-default in the input fixture; they are
        // validated against the `expected` record create() returns.
        id: "derived-on-write",
        createdAt: "derived-on-write",
        updatedAt: "derived-on-write",
        "layout.workflowId": "derived-on-write",
        // `accessPolicy` survives ONLY on legacy stored records (the tolerant
        // persisted schema preserves it verbatim); the authored accept path
        // this contract persists through refuses it, so a maximal CREATABLE
        // fixture cannot carry it. Its read-path preservation is proven by the
        // legacy-frozen-charter tolerance test instead.
        "definition.charter.sourcesOfTruth[0].accessPolicy": "not-persisted",
        "definition.charter.sourcesOfTruth[1].accessPolicy": "not-persisted",
      },
    });
  });

  it("round-trips the same maximal definition record through the GLOBAL scope under the reserved key", async () => {
    const storage = storageForContract();

    await assertRoundTripDurability({
      label: "workflow-definition-storage-global",
      schema: workflowDefinitionRecordSchema,
      buildMaximalFixture: () =>
        buildMaximalRecord(buildGlobalScopeMaximalDefinition()),
      persist: async (fixture) =>
        storage.create(
          { kind: "global" },
          {
            name: fixture.name,
            description: fixture.description,
            definition: fixture.definition,
            layout: fixture.layout,
          },
        ),
      reload: (expected) => storage.get({ kind: "global" }, expected.id),
      fieldPolicies: {
        schemaVersion: "not-persisted",
        id: "derived-on-write",
        createdAt: "derived-on-write",
        updatedAt: "derived-on-write",
        "layout.workflowId": "derived-on-write",
        // See the project-scope contract above: refused by the authored accept
        // path, preserved only on legacy stored records.
        "definition.charter.sourcesOfTruth[0].accessPolicy": "not-persisted",
        "definition.charter.sourcesOfTruth[1].accessPolicy": "not-persisted",
      },
    });
  });

  it("stores a global record under the reserved scope, isolated from any project scope", async () => {
    const storage = storageForContract();

    const created = await storage.create(
      { kind: "global" },
      {
        name: "Global-only template",
        description: null,
        definition: buildGlobalScopeMaximalDefinition(),
        layout: {
          workflowId: "placeholder-id",
          contextPositions: { "ctx-1": { x: 1, y: 2 } },
          viewport: { x: 0, y: 0, zoom: 1 },
        },
      },
    );

    // The global record is retrievable under the global scope...
    expect((await storage.get({ kind: "global" }, created.id))?.id).toBe(
      created.id,
    );
    // ...and a project scope (a distinct, base64url-derived directory key) does
    // not see it, proving the reserved global key routes to its own store.
    expect(
      await storage.get(
        { kind: "project", projectPath: PROJECT_PATH },
        created.id,
      ),
    ).toBeNull();
    const globalList = await storage.list({ kind: "global" });
    expect(globalList.map((r) => r.id)).toContain(created.id);
  });
});
