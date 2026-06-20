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
        "delegated: bounds enforced by the graph_workflow_execution document entry.",
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
    label: "graph_workflow_execution document",
    schema: graphWorkflowExecutionSchema,
    discharges: {
      "workingDefinition.**":
        "bounded: immutable resolved workflow definition (contexts, tasks, edges, per-context charters) fixed at resolve time, never mutated at runtime.",
      "charter.**": "bounded: author-fixed workflow charter.",
      activeContextIds:
        "bounded: subset of the author-fixed execution contexts.",
      contextStates: "bounded: keyed by the author-fixed execution contexts.",
      taskStates: "bounded: keyed by the author-fixed task graph.",
      "taskStates.*.failureHistory":
        "pruned: capped to the last 10 entries via appendFailureHistory in iteration-orchestrator.",
      collaborationContinuations: "bounded: keyed by execution context.",
      "collaborationContinuations.*":
        "pruned: consumed continuations removed on delivery in iteration-orchestrator (emptied context keys deleted).",
      "collaborationContinuations.*[].result.openConflicts":
        "bounded: conflicting files from one merge attempt.",
      executionLanes: "bounded: keyed by the author-fixed execution lanes.",
      "executionLanes.*.includedContextIds":
        "bounded: subset of the author-fixed execution contexts.",
      "executionLanes.*.commitSnapshots":
        "tracked: grows one entry per lane commit with no eviction — graph_workflow_execution normalization (structural change #4).",
      "laneStates.**": "bounded: keyed by the execution lanes.",
      "joins.**":
        "bounded: per-join merge state keyed by author-fixed joins; lane-id and conflict-file lists sized by the merge.",
      "lanePlan.**":
        "bounded: continuation / longest-path maps derived from the author-fixed graph.",
      "haltReason.**":
        "bounded: single halt descriptor (conflict files / source lanes from one halt).",
      "pendingHaltReason.**": "bounded: single pending halt descriptor.",
      "secondaryHaltReasons.**":
        "bounded: one entry per halted secondary lane (at most the execution-lane count).",
      pendingCollaborations:
        "bounded: in-flight collaboration requests for the current batch, drained as delivered.",
      pendingMergeRetry: "bounded: single pending merge-retry descriptor.",
      sharedDocuments:
        "tracked: one entry per workflow-produced shared document with no eviction — graph_workflow_execution normalization (structural change #4).",
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
