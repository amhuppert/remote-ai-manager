import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compactionEnvelopeSchema } from "@/lib/context-artifacts/schemas";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import { persistedConversationSnapshotSchema } from "@/lib/workflows/conversation/persisted-snapshot-codec";
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
 * so a bounded subtree needs only one entry). The value explains why the
 * collection cannot grow unbounded in a single column:
 *   - "normalized: <table>"  — not a blob; lives in its own child table.
 *   - "not-persisted"         — dropped on write (see the durability contract).
 *   - "pruned: <where>"       — evicted to a bounded working set by named code.
 *   - "bounded: <why>"        — capped by construction (author-shaped graph, one
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
      pendingAgentNotices:
        "pruned: capped to the most recent entries at append (background-tasks-lost handler in actor-implementations); drained into the next runtime's session instructions and cleared.",
      "pendingQueue[].content[].input.**":
        "tracked: opaque tool-call input (z.unknown map values), validated at the message-content boundary but unschema'd in the blob; size bounded only by one queued message's tool calls, not by this schema.",
      "pendingQueue[].content[].payload":
        "tracked: opaque tool-result payload (z.unknown), validated at the message-content boundary but unschema'd in the blob; size bounded only by one queued message.",
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
      "workflowEnvelopes.*":
        "tracked: opaque envelope value (z.unknown), validated at the WorkflowEnvelopeStore boundary; unschema'd in this blob, heavy stream externalized to collab-artifacts sidecar files.",
      workflowLanes:
        "bounded: keyed by workflow lane id (one per execution context).",
      "workflowLanes.*":
        "tracked: opaque lane value (z.unknown), validated at the LaneStore boundary (laneStateSchema); unschema'd in this blob.",
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
        "bounded: resolved workflow definition (contexts, tasks, edges, per-context charters) sized at resolve time and written on accepted live edits (lane-agent add_task and doc-06 live editing); every mutation is author-shaped content bounded by the same limits as the seeded definition. In graph_workflow_executions.definition_json.",
      "charter.**":
        "bounded: workflow charter — author-shaped at seed, rewritten wholesale by an accepted amend-charter live edit (doc 07); every rewrite is author-shaped content under the same schema limits. In graph_workflow_executions.definition_json.",
      charterAmendments:
        "tracked: grows one metadata-only entry (seq/timestamp/source/rationale/fieldsChanged/hash) per accepted amend-charter live edit, no eviction — full charter snapshots are deliberately NOT stored (doc 07 F2 keeps growth to audit metadata). In graph_workflow_executions.runtime_json.",
      "charterAmendments[].fieldsChanged":
        "bounded: subset of the eight top-level charter content field names (CHARTER_CONTENT_EDIT_FIELDS). In graph_workflow_executions.runtime_json.",
      boundInputs:
        "bounded: one string value per author-declared launch parameter, fixed at seed and never mutated. In graph_workflow_executions.definition_json.",
      // --- runtime_json tier (hot, rewritten every tick) ---
      machineSnapshot:
        "tracked: opaque XState snapshot (z.unknown) for the graph-workflow execution machine — a different field from the conversation machineSnapshot that the 2026-07-20 projection+sidecar removed (Design 1), and out of that design's scope. Remains opaque on runtime_json.",
      activeContextIds:
        "bounded: subset of the author-fixed execution contexts. In graph_workflow_executions.runtime_json.",
      contextStates:
        "bounded: keyed by the author-fixed execution contexts. In graph_workflow_executions.runtime_json.",
      "contextStates.*.pendingUserInput.**":
        "bounded: one in-flight AskUserQuestion set snapshotted at park (plus its recorded answers), cleared on resume or withdraw. In graph_workflow_executions.runtime_json.",
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
  {
    // The conversation machine snapshot resume token, serialized whole into the
    // conversation_machine_snapshots.snapshot_json sidecar column. The projection
    // codec dropped lastResult.contentBlocks / children (the multi-MB carriers),
    // but the token still holds the XState envelope (opaque machine internals)
    // and the projected machine context, so every collection / opaque node in it
    // is gated here just like any other persisted blob.
    label: "conversation_machine_snapshots snapshot_json",
    schema: persistedConversationSnapshotSchema,
    discharges: {
      // --- XState envelope (looseObject passthrough of machine internals) ---
      value:
        "tracked: opaque XState state value (z.unknown) — the current state-node config, bounded by the machine's static statechart, not by content.",
      historyValue:
        "tracked: opaque XState history value (z.unknown), bounded by the machine's static statechart.",
      output:
        "tracked: opaque XState machine output (z.unknown); the conversation machine is long-lived with no final state, so this is effectively always absent.",
      error: "tracked: opaque XState error envelope field (z.unknown).",
      "*": "tracked: opaque XState-internal envelope fields (looseObject passthrough) the machine needs to resolve state on resume; author-shaped machine internals, not user content.",
      // --- projected machine context ---
      "context.activeTurn.images":
        "bounded: image payloads attached to the one in-flight turn (a single prompt's uploads), cleared when the turn settles.",
      "context.activeTurn.*":
        "tracked: opaque passthrough fields of the ActiveTurn union (looseObject) owned by conversation/types.ts; author-shaped and bounded by that interface — the pinned kind + images are the only growable payloads.",
      "context.pendingQuestion.**":
        "bounded: one in-flight AskUserQuestion set (its items and each item's fixed options), cleared when answered.",
      "context.debugMode.**":
        "bounded: one active debug investigation's working set (hypotheses / reproduction / verification steps).",
      "context.lastResult.structuredOutput":
        "tracked: opaque structured-output payload (z.unknown) of the last turn; validated at the backend structured-output boundary, bounded by one turn's output, unschema'd in this blob.",
      "context.lastResult.backgroundWait.**":
        "bounded: task ids from one turn's background-wait summary, bounded by that turn's spawned background tasks.",
    },
  },
  {
    label: "context_artifacts payload_json",
    schema: compactionEnvelopeSchema,
    discharges: {
      "decisions.**":
        "bounded: single model-generated envelope, rewritten whole per compaction run (generation output guards, design §7.3); never appended to across runs.",
      "files.**":
        "bounded: single model-generated envelope, rewritten whole per compaction run; never appended to across runs.",
      "commands.**":
        "bounded: single model-generated envelope, rewritten whole per compaction run; never appended to across runs.",
      "openQuestions.**":
        "bounded: single model-generated envelope, rewritten whole per compaction run; never appended to across runs.",
      "blockers.**":
        "bounded: single model-generated envelope, rewritten whole per compaction run; never appended to across runs.",
      "currentState.nextBestActions":
        "bounded: single model-generated envelope, rewritten whole per compaction run; never appended to across runs.",
      extras:
        "bounded: single model-generated envelope, rewritten whole per compaction run; ungraduated fields only, capped by the same output guards.",
      "extras.*":
        "tracked: opaque ungraduated envelope field values (z.unknown), capped by the same generation output guards as the typed fields; unschema'd until a field graduates to a typed top-level field.",
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

  it("fails when a new opaque blob is added, and only a `tracked:` discharge clears it", () => {
    const conversationsBlob = PERSISTED_BLOBS[0];
    if (!conversationsBlob) throw new Error("registry is empty");

    // The exact `machineSnapshot` blind spot the projection+sidecar removed:
    // an opaque `z.unknown()` field slipped past the gate because it had no
    // JSON-schema projection. The extended gate now surfaces it.
    const withOpaqueBlob = conversationStateSchema.extend({
      opaqueBlob: z.unknown(),
    });
    const found = findUnboundedCollections(withOpaqueBlob);
    expect(found).toContainEqual({ path: "opaqueBlob", kind: "opaque" });

    // Undischarged by default.
    expect(
      reconcileDischarges(found, conversationsBlob.discharges).undischarged.map(
        (node) => node.path,
      ),
    ).toContain("opaqueBlob");

    // A `bounded:` discharge does NOT clear an opaque node — you cannot inspect
    // a value the schema renders as `{}`.
    expect(
      reconcileDischarges(found, {
        ...conversationsBlob.discharges,
        opaqueBlob: "bounded: it's small, promise",
      }).undischarged.map((node) => node.path),
    ).toContain("opaqueBlob");

    // A `tracked:` discharge clears it.
    expect(
      reconcileDischarges(found, {
        ...conversationsBlob.discharges,
        opaqueBlob: "tracked: opaque resume token, addressed by the sidecar",
      }).undischarged.map((node) => node.path),
    ).not.toContain("opaqueBlob");
  });
});
