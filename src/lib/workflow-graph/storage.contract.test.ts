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
import { assertRoundTripDurability } from "@/lib/shared/testing/round-trip-durability";
import { createWorkflowStorageService } from "./storage";

const PROJECT_PATH = "/durability-project";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(path.join(tmpdir(), "cc-workflow-storage-contract-"));
});

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
      },
    ],
    workflowConfig: {
      implementer: {
        backend: "claude",
        model: "opus",
        reasoningEffort: "high",
      },
      contextValidator: {
        type: "claude",
        enabled: true,
        continuity: { enabled: false, contextLimitTokens: 110_000 },
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      },
      scriptValidator: { enabled: true },
      iterationPolicy: {
        maxIterations: 9,
        continuity: { enabled: false, contextLimitTokens: 80_000 },
      },
      circuitBreaker: { consecutiveFailureThreshold: 4 },
      mutability: { allowAgentTaskAdd: true },
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
    },
    charter: makeTestCharter(),
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
        origin: {
          sourceUri: "workflow-source:maximal/context/ctx-1",
          label: "Maximal context source",
        },
        implementer: {
          backend: "claude",
          model: "opus",
          reasoningEffort: "high",
        },
        contextValidator: {
          kind: "use",
          value: {
            type: "claude",
            enabled: true,
            continuity: { enabled: false, contextLimitTokens: 120_000 },
            agent: {
              backend: "claude",
              model: "sonnet",
              reasoningEffort: "medium",
            },
          },
        },
        scriptValidator: { enabled: true },
        mutability: { allowAgentTaskAdd: true },
        circuitBreaker: { consecutiveFailureThreshold: 5 },
        iterationPolicy: {
          maxIterations: 7,
          continuity: { enabled: false, contextLimitTokens: 90_000 },
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
      },
      // A second context exists only as the edge target so the single
      // representative edge can connect two distinct contexts (a self-loop
      // would register as a cycle). The harness descends into the first context
      // and the first edge only, so this one stays minimal.
      {
        id: "ctx-2",
        title: "Downstream context",
        acceptanceCriteria: "Downstream criteria satisfied",
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
function buildMaximalRecord(): WorkflowDefinitionRecord {
  return {
    id: "placeholder-id",
    name: "Maximal durable workflow",
    description: "A fully-populated definition record for the durability check",
    schemaVersion: 1,
    revision: 1,
    definition: buildMaximalDefinition(),
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
    const storage = createWorkflowStorageService({
      resolveConfigDir: () => tempDir,
    });

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
      },
    });
  });

  it("round-trips the same maximal definition record through the GLOBAL scope under the reserved key", async () => {
    const storage = createWorkflowStorageService({
      resolveConfigDir: () => tempDir,
    });

    await assertRoundTripDurability({
      label: "workflow-definition-storage-global",
      schema: workflowDefinitionRecordSchema,
      buildMaximalFixture: buildMaximalRecord,
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
      },
    });
  });

  it("stores a global record under the reserved scope, isolated from any project scope", async () => {
    const storage = createWorkflowStorageService({
      resolveConfigDir: () => tempDir,
    });

    const created = await storage.create(
      { kind: "global" },
      {
        name: "Global-only template",
        description: null,
        definition: buildMaximalDefinition(),
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
