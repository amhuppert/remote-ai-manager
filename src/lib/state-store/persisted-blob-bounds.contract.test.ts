import { describe, expect, it } from "vitest";
import { z } from "zod";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { graphWorkflowExecutionSchema } from "@/lib/workflows/schemas";
import {
  findUnboundedCollections,
  reconcileDischarges,
} from "@/lib/shared/testing/persisted-blob-bounds";

/**
 * Persisted-blob bounds gate.
 *
 * Every Zod schema whose value is serialized whole into a single SQLite TEXT
 * column is registered here. The gate flags any array or open map inside one of
 * those schemas that lacks a static `.max()` bound, and fails unless the
 * collection is explicitly discharged below.
 *
 * A discharge key is a path prefix (it covers its own node and every descendant,
 * so an immutable subtree needs only one entry). The value explains why the
 * collection cannot grow unbounded in a single column:
 *   - "normalized: <table>"  — not a blob; lives in its own child table.
 *   - "not-persisted"         — dropped on write (see the durability contract).
 *   - "pruned: <where>"       — evicted to a bounded working set by named code.
 *   - "bounded: <why>"        — capped by construction (author-fixed graph, one
 *                               in-flight set, etc.).
 *
 * Adding an unbounded collection to a persisted blob fails this gate until the
 * author either caps it with `.max()` or records why it is bounded here — which
 * is the decision we keep paying for when it is deferred to production.
 */
interface PersistedBlob {
  readonly label: string;
  readonly schema: z.ZodType;
  readonly discharges: Readonly<Record<string, string>>;
}

const PERSISTED_BLOBS: readonly PersistedBlob[] = [
  {
    label: "conversations row",
    schema: conversationStateSchema,
    discharges: {
      spawnedSessionIds:
        "not-persisted: PLC-only field; the conversations table has no column (lives on project_conversations).",
      "pendingQuestions.**":
        "bounded: one in-flight AskUserQuestion set, cleared when answered.",
      "debugMode.**":
        "bounded: one active debug investigation's working set (hypotheses / steps).",
      "mcpOverrides.**":
        "bounded: keyed by the configured MCP servers and their tools.",
      "mcpRuntime.**":
        "bounded: pending server keys sized by the configured MCP servers.",
      "agentCapabilityOverrides.**":
        "bounded: keyed by the configured capability cascade.",
      "agentCapabilitiesRuntime.**":
        "bounded: pending item ids sized by the configured capability cascade.",
      "pendingQueue.**":
        "pruned: terminal entries evicted in message-queue-service (active-only working set); per-entry content/input bounded by one message.",
    },
  },
  {
    label: "sessions row",
    schema: sessionStateSchema,
    discharges: {
      "conversations.**":
        "normalized: conversations table; joined into SessionState in-memory, never stored on the sessions row.",
      referenceDocuments:
        "normalized: reference_documents table; joined in-memory, never stored on the sessions row.",
      "graphWorkflowExecution.**":
        "not-persisted: never stored on the sessions row (set to null by rowToDomain); the active execution lives in graph_workflow_executions.definition_json / runtime_json, registered below.",
      workflowEnvelopes:
        "bounded: keyed by active workflow envelope id; heavy per-turn artifact stream externalized to collab-artifacts sidecar files.",
      workflowLanes:
        "bounded: keyed by workflow lane id (one per execution context).",
      "mcpOverrides.**":
        "bounded: keyed by the configured MCP servers and their tools.",
      "agentCapabilityOverrides.**":
        "bounded: keyed by the configured capability cascade.",
    },
  },
  {
    // The active execution is split across two TEXT columns of the
    // graph_workflow_executions table: the definition tier
    // (graph_workflow_executions.definition_json) and the runtime tier
    // (graph_workflow_executions.runtime_json). Both columns are still single
    // serialized blobs, so every collection inside them is gated here.
    label: "graph_workflow_executions definition_json + runtime_json",
    schema: graphWorkflowExecutionSchema,
    discharges: {
      // --- definition_json tier (near-static, written only when its hash changes) ---
      "workingDefinition.**":
        "bounded: immutable resolved workflow definition (contexts, tasks, edges, per-context charters) fixed at resolve time, never mutated at runtime. In graph_workflow_executions.definition_json.",
      "charter.**":
        "bounded: author-fixed workflow charter. In graph_workflow_executions.definition_json.",
      // --- runtime_json tier (hot, rewritten every tick) ---
      activeContextIds:
        "bounded: subset of the author-fixed execution contexts. In graph_workflow_executions.runtime_json.",
      contextStates:
        "bounded: keyed by the author-fixed execution contexts. In graph_workflow_executions.runtime_json.",
      taskStates:
        "bounded: keyed by the author-fixed task graph. In graph_workflow_executions.runtime_json.",
      "taskStates.*.failureHistory":
        "pruned: capped to the last 10 entries via appendFailureHistory in iteration-orchestrator. In graph_workflow_executions.runtime_json.",
      collaborationContinuations:
        "bounded: keyed by execution context. In graph_workflow_executions.runtime_json.",
      "collaborationContinuations.*":
        "pruned: consumed continuations removed on delivery in iteration-orchestrator (emptied context keys deleted). In graph_workflow_executions.runtime_json.",
      "collaborationContinuations.*[].result.openConflicts":
        "bounded: conflicting files from one merge attempt. In graph_workflow_executions.runtime_json.",
      executionLanes:
        "bounded: keyed by the author-fixed execution lanes. In graph_workflow_executions.runtime_json.",
      "executionLanes.*.includedContextIds":
        "bounded: subset of the author-fixed execution contexts. In graph_workflow_executions.runtime_json.",
      "executionLanes.*.commitSnapshots":
        "tracked: grows one entry per lane commit with no eviction — graph_workflow_execution normalization (structural change #4). In graph_workflow_executions.runtime_json.",
      "laneStates.**":
        "bounded: keyed by the execution lanes. In graph_workflow_executions.runtime_json.",
      "joins.**":
        "bounded: per-join merge state keyed by author-fixed joins; lane-id and conflict-file lists sized by the merge. In graph_workflow_executions.runtime_json.",
      "lanePlan.**":
        "bounded: continuation / longest-path maps derived from the author-fixed graph. In graph_workflow_executions.definition_json.",
      "haltReason.**":
        "bounded: single halt descriptor (conflict files / source lanes from one halt). In graph_workflow_executions.runtime_json.",
      "pendingHaltReason.**":
        "bounded: single pending halt descriptor. In graph_workflow_executions.runtime_json.",
      "secondaryHaltReasons.**":
        "bounded: one entry per halted secondary lane (at most the execution-lane count). In graph_workflow_executions.runtime_json.",
      pendingCollaborations:
        "bounded: in-flight collaboration requests for the current batch, drained as delivered. In graph_workflow_executions.runtime_json.",
      pendingMergeRetry:
        "bounded: single pending merge-retry descriptor. In graph_workflow_executions.runtime_json.",
      sharedDocuments:
        "tracked: one entry per workflow-produced shared document with no eviction — graph_workflow_execution normalization (structural change #4). In graph_workflow_executions.runtime_json.",
    },
  },
];

describe("persisted blob bounds gate", () => {
  for (const blob of PERSISTED_BLOBS) {
    describe(blob.label, () => {
      const found = findUnboundedCollections(blob.schema);

      it("declares a bound for every unbounded collection", () => {
        const { undischarged } = reconcileDischarges(found, blob.discharges);
        expect(
          undischarged.map((node) => `${node.path} (${node.kind})`),
        ).toEqual([]);
      });

      it("has no stale discharge entries", () => {
        const { staleDischargeKeys } = reconcileDischarges(
          found,
          blob.discharges,
        );
        expect(staleDischargeKeys).toEqual([]);
      });
    });
  }

  it("fails when a new unbounded collection is added to a registered blob", () => {
    const conversationsBlob = PERSISTED_BLOBS[0];
    if (!conversationsBlob) throw new Error("registry is empty");

    const withNewField = conversationStateSchema.extend({
      auditTrail: z.array(z.string()),
    });
    const found = findUnboundedCollections(withNewField);
    const { undischarged } = reconcileDischarges(
      found,
      conversationsBlob.discharges,
    );

    expect(undischarged.map((node) => node.path)).toContain("auditTrail");
  });
});
