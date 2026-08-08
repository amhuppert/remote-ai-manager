import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compactionEnvelopeSchema } from "@/lib/context-artifacts/schemas";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import { graphWorkflowExecutionEventSchema } from "@/lib/workflow-graph/event-schemas";
import { persistedConversationSnapshotSchema } from "@/lib/workflows/conversation/persisted-snapshot-codec";
import {
  describeCollections,
  findUnboundedCollections,
  reconcileDischarges,
} from "@/lib/shared/testing/persisted-blob-bounds";
import { D4_PERSISTED_FIELDS } from "@/lib/shared/testing/d4-persisted-field-inventory";

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
        "bounded: resolved workflow definition (contexts, tasks, edges, per-context charters, and each loop group's frozen body template) sized at resolve time and written on accepted live edits (lane-agent add_task, doc-06 live editing, expansion, loop unrolling); every mutation is author-shaped content bounded by the same limits as the seeded definition, and a loop template is a snapshot of authored body contexts rather than a per-pass accumulator. In graph_workflow_executions.definition_json.",
      "workingDefinition.executionContexts[].contextValidator.assignments":
        "bounded: one entry per configured validator assignment in the context's cohort, fixed by the cascade at seed time and replaced whole (never appended to) by a live config edit. Each entry carries a resolved profile snapshot whose instruction text is bounded by the agent-profile authoring limits, so the subtree's size is cohort size x one profile — not a growing series. In graph_workflow_executions.definition_json.",
      "workingDefinition.loopGroups[].until.schema.**":
        "tracked: opaque author-declared loop exit predicate (a record of z.unknown values), validated at definition-accept time against the supported-keyword subset plus a compatibility walk against the exit context's outputSchema, and unschema'd here; sized by one authored predicate, written only when the definition tier changes. In graph_workflow_executions.definition_json.",
      "workingDefinition.loopGroups[].template.contexts[].outputSchema.**":
        "tracked: opaque author-declared JSON Schema document for a loop body context, on the same accept-time subset contract as executionContexts[].outputSchema; sized by one body context's authored output shape and frozen into the template at seed. In graph_workflow_executions.definition_json.",
      "workingDefinition.loopGroups[].template.edges[].when.**":
        "tracked: opaque author-declared edge-guard document for an edge INSIDE a loop body, on the same accept-time subset contract as edges[].when; sized by one authored guard and frozen into the template at seed. In graph_workflow_executions.definition_json.",
      "workingDefinition.executionContexts[].outputSchema.**":
        "tracked: opaque author-declared JSON Schema document (a record of z.unknown values), validated at definition-accept time against the supported-keyword subset and unschema'd here; sized by one context's authored output shape, written only when the definition tier changes. In graph_workflow_executions.definition_json.",
      "workingDefinition.edges[].when.**":
        "tracked: opaque author-declared edge-guard document (a record of z.unknown values), validated at definition-accept time against the same supported-keyword subset plus a compatibility walk against the source's outputSchema, and unschema'd here; sized by one edge's authored guard, written only when the definition tier changes. In graph_workflow_executions.definition_json.",
      "charter.**":
        "bounded: workflow charter — author-shaped at seed, rewritten wholesale by an accepted amend-charter live edit (doc 07); every rewrite is author-shaped content under the same schema limits. In graph_workflow_executions.definition_json.",
      charterAmendments:
        "tracked: grows one metadata-only entry (seq/timestamp/source/rationale/fieldsChanged/hash) per accepted amend-charter live edit, no eviction — full charter snapshots are deliberately NOT stored (doc 07 F2 keeps growth to audit metadata). In graph_workflow_executions.runtime_json.",
      "charterAmendments[].fieldsChanged":
        "bounded: subset of the eight top-level charter content field names (CHARTER_CONTENT_EDIT_FIELDS). In graph_workflow_executions.runtime_json.",
      planRepairRounds:
        "bounded: one metadata-only entry per plan-repair round, appended before the agent runs and never evicted; rounds are capped by planRepair.maxAttemptsPerContext per context and the hard PLAN_REPAIR_MAX_ROUNDS_PER_EXECUTION backstop of 5 per execution (docs/design/cc-cli/08). In graph_workflow_executions.runtime_json.",
      loopControlAmendments:
        "tracked: grows one metadata-only entry (seq/loopGroupId/kind/rationale/revisions/timestamp) per ACCEPTED loop-control edit, no eviction — like charterAmendments, the amended predicate/cap/template live on the working definition and are deliberately not snapshotted here (D4 R11.2/R12). Growth needs quiescence per edit and is bounded in practice by the plan-repair round caps plus operator action; an execution that accumulated thousands would be a runaway an operator is already watching. In graph_workflow_executions.runtime_json.",
      boundInputs:
        "bounded: one string value per author-declared launch parameter, fixed at seed and never mutated. In graph_workflow_executions.definition_json.",
      // --- runtime_json tier (hot, rewritten every tick) ---
      machineSnapshot:
        "tracked: opaque XState snapshot (z.unknown) for the graph-workflow execution machine — a different field from the conversation machineSnapshot that the 2026-07-20 projection+sidecar removed (Design 1), and out of that design's scope. Remains opaque on runtime_json.",
      activeContextIds:
        "bounded: subset of the author-fixed execution contexts. In graph_workflow_executions.runtime_json.",
      contextStates:
        "bounded: keyed by the author-fixed execution contexts. In graph_workflow_executions.runtime_json.",
      "contextStates.*.pendingUserInputs.**":
        "bounded: at most one in-flight AskUserQuestion set per LANE of the context (keyed by lane key: the one implementer plus the context's author-fixed validator cohort), each snapshotted at park with its recorded answers and cleared on resume or withdraw. In graph_workflow_executions.runtime_json.",
      "contextStates.*.validationRound.**":
        "bounded: exactly one latest validation round per context; a concluded round is retained for monotonic sequence numbering until the next round replaces it. Its roster and per-assignment specialist map are sized by the context's author-fixed validator cohort, and each specialist's issues, session ref, and review artifact come from one validator turn — none of it is a series that grows across rounds. In graph_workflow_executions.runtime_json.",
      "contextStates.*.validationRound.specialists.*.sessionRef.backend":
        "tracked: opaque only to this walker — the backend id of the lane that rendered the verdict, shape-validated (a non-empty registry key) because backend membership is resolved by the registry rather than by this schema. A short token, not a payload and not a series. In graph_workflow_executions.runtime_json.",
      "contextStates.*.validationRound.specialists.*.reviewArtifact.backend":
        "tracked: opaque only to this walker — the backend id that produced the review artifact, shape-validated for the same reason as its sessionRef counterpart above. In graph_workflow_executions.runtime_json.",
      "contextStates.*.skipReason.edgeEvaluations":
        "bounded: one verdict per incoming edge of the skipped context, written once when the skip settles; `skipped` is terminal, so it is never appended to afterwards. In graph_workflow_executions.runtime_json.",
      taskStates:
        "bounded: keyed by the author-fixed task graph. In graph_workflow_executions.runtime_json.",
      "taskStates.*.failureHistory":
        "pruned: capped to the last 10 entries via appendFailureHistory in iteration-orchestrator. In graph_workflow_executions.runtime_json.",
      contextOutputs:
        "bounded: at most one captured structured output per author-fixed execution context, written once when that context settles. In graph_workflow_executions.runtime_json.",
      "contextOutputs.*.value.**":
        "tracked: opaque validated agent output (a record of z.unknown values) in the author's own vocabulary, unschema'd here; sized by one context's authored outputSchema and written once per context. Deliberately NOT discharged as the whole `contextOutputs.**` subtree, so a growable field added beside `value` still has to answer to this gate. In graph_workflow_executions.runtime_json.",
      routeControlRevisions:
        "bounded: one small integer per execution context that owns conditional out-edges; keys are dropped with their context, so the map is sized by the live context set rather than by edit history. In graph_workflow_executions.runtime_json.",
      routeSettlements:
        "bounded: at most one CURRENT settlement marker per execution context that owns conditional out-edges, replaced (never appended to) when its dedup key moves; the unbounded decision ledger lives in graph_workflow_events instead (D4 decision D4). In graph_workflow_executions.runtime_json.",
      loopStates:
        "bounded: one ledger entry per SEED-DECLARED loop group — loops are authored only, never added at runtime (R11.1) — so the map is sized by the definition. In graph_workflow_executions.runtime_json.",
      "loopStates.*.slotLedger":
        "bounded: one grant per pass (idempotent per pass — a re-decided pass re-uses its grant rather than appending one), and a loop's passes are capped by its mandatory `maxPasses`; across every loop group the per-execution 25-pass backstop caps the total, so the ledgers of one execution hold at most 25 live grants no matter how the caps are amended. In graph_workflow_executions.runtime_json.",
      "loopStates.*.decisions":
        "bounded: the LATEST decision per pass, replaced (never appended to) when its dedup key moves, so it is capped by `maxPasses` like the ledger; the unbounded decision history — including repeated re-decisions of one pass under amended control revisions — lives in graph_workflow_events instead (D4 R16.1). In graph_workflow_executions.runtime_json.",
      "loopStates.*.passTemplateVersions":
        "bounded: one small integer per pass of that loop, written once when the pass is materialized and never re-keyed, so it is capped by `maxPasses` exactly like the slot ledger and the decision map — and by the per-execution 25-pass backstop across every loop. In graph_workflow_executions.runtime_json.",
      "loopStates.*.boundaryInputs":
        "bounded: the loop entry's direct predecessors, snapshotted once at activation and never re-taken, so it is sized by the authored graph. In graph_workflow_executions.runtime_json.",
      "loopStates.*.boundaryInputs[].schemaFields":
        "bounded: the top-level properties of one predecessor's authored outputSchema. In graph_workflow_executions.runtime_json.",
      "loopStates.*.boundaryInputs[].output.**":
        "tracked: opaque validated agent output (a record of z.unknown values) copied from that predecessor's capture, on the same accept-time subset contract as contextOutputs.*.value; sized by one context's authored outputSchema and written once, at loop activation. In graph_workflow_executions.runtime_json.",
      "routeSettlements.*.activatedEdgeIds":
        "bounded: subset of that source's outgoing edges. In graph_workflow_executions.runtime_json.",
      "routeSettlements.*.inactiveEdgeIds":
        "bounded: subset of that source's outgoing edges. In graph_workflow_executions.runtime_json.",
      "routeSettlements.*.omittedEdgeIds":
        "bounded: subset of that source's outgoing edges. In graph_workflow_executions.runtime_json.",
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
      "contextStates.*.reservedOwnership.canonicalPrefixes":
        "bounded: one canonical path per prefix the context's authored placement declares, so it is sized by the definition rather than by the run. In graph_workflow_executions.runtime_json.",
      laneReservations:
        "pruned: a lane claim exists only between a scheduling batch's reserve and its finalize (or its compensating release), which both delete every reservation the batch owns. In graph_workflow_executions.runtime_json.",
      "laneReservations.*.members":
        "bounded: the contexts one batch admitted onto that lane, at most the author-fixed execution-context count. In graph_workflow_executions.runtime_json.",
      "laneReservations.*.members[].ownership.canonicalPrefixes":
        "bounded: one canonical path per prefix that member's authored placement declares. In graph_workflow_executions.runtime_json.",
      "laneStates.**":
        "bounded: outer keys are author-fixed execution contexts; inner keys are the one implementer plus that context's author-fixed validator assignments. In graph_workflow_executions.runtime_json.",
      "joins.**":
        "bounded: per-join merge state keyed by author-fixed joins; lane-id and conflict-file lists sized by the merge. In graph_workflow_executions.runtime_json.",
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
      advisoryIndex:
        "tracked: grows one metadata-only entry (identity, kind, title, origin context) per `plan` or `out_of_scope` advisory raised anywhere in the run, with no eviction — the index outlives the rounds it projects, which is the point of it (R9, D9). A seat's entries are replaced, not appended, when it re-reports inside one round, so growth per round is bounded by the cohort's advisory output; the title is the only free text and the advisory's description stays on the round record. In graph_workflow_executions.runtime_json.",
    },
  },
  {
    // One row of the append-only execution event log. The wrapped SSE payload is
    // serialized whole into graph_workflow_events.event_json, so every collection
    // inside ANY variant of the union is a single-column blob and is gated here.
    // The union projects to `anyOf` at one path, so a field name shared by two
    // variants collapses to one entry — the discharge has to hold for every
    // variant that carries it.
    label: "graph_workflow_events event_json",
    schema: graphWorkflowExecutionEventSchema,
    discharges: {
      // --- lifecycle snapshots: subsets of the author-fixed graph ---
      "event.activeContextIds":
        "bounded: subset of the execution contexts live at that tick.",
      "event.activeBatchIds":
        "bounded: subset of the in-flight scheduling batches at that tick.",
      "event.activeJoinIds":
        "bounded: subset of the author-fixed joins in flight at that tick.",
      "event.contextIds":
        "bounded: the contexts one scheduling batch dispatched, a subset of the execution contexts.",
      "event.includedContextIds":
        "bounded: the execution contexts assigned to one lane, a subset of the execution contexts.",
      // --- halt descriptors: one halt each, never appended to ---
      "event.haltReason.**":
        "bounded: a single halt descriptor (unmet delivery-gate criteria, conflict files, source lanes, or the edge/context ids of one routing halt), written once when the halt is raised.",
      "event.pendingHaltReason.**":
        "bounded: a single pending halt descriptor, same shape and same one-halt bound as haltReason.",
      "event.secondaryHaltReasons.**":
        "bounded: one halt descriptor per halted secondary lane, so at most the execution-lane count.",
      // --- routing verdicts (D4) ---
      "event.edgeEvaluations":
        "bounded: one verdict per incoming edge of the skipped context, written once when the skip settles; `skipped` is terminal, so the row is never revised.",
      "event.activatedEdgeIds":
        "bounded: subset of that source context's outgoing edges.",
      "event.inactiveEdgeIds":
        "bounded: subset of that source context's outgoing edges.",
      "event.omittedEdgeIds":
        "bounded: subset of that source context's outgoing edges.",
      // --- join conflict records ---
      "event.resolvedConflicts":
        "bounded: at most one record per source lane of one author-fixed join, appended only as that join merges its lanes and cleared when the join is reset for retry.",
      "event.resolvedConflicts[].files":
        "bounded: the conflicted paths of one lane merge, as reported by git for that single merge.",
      "event.resolvedConflicts[].analysis":
        "bounded: one resolver verdict per conflicted file of that same single lane merge, written once when the merge concludes.",
      // --- validation verdicts ---
      "event.reopenTaskIds":
        "bounded: subset of the validated context's tasks.",
      "event.issues":
        "bounded: one validator verdict's issues, written once per validation round and capped by the same output guards as the verdict itself.",
      "event.rejectedAgainstSchema.**":
        "tracked: opaque author-declared JSON Schema document (a record of z.unknown values) the output was refused against, on the same accept-time subset contract as the context's outputSchema; sized by one context's authored output shape and written once per rejection.",
      "event.sessionRef.backend":
        "tracked: opaque registered agent-backend id (backend-neutral descriptor key), validated at the backend registry boundary; a single identifier, not a container.",
      "event.reviewArtifact.backend":
        "tracked: opaque registered agent-backend id, same registry boundary and same single-identifier bound as sessionRef.backend.",
      "event.specialists":
        "bounded: one entry per enabled assignment in the concluded round's frozen, author-fixed validator cohort; the aggregate event is written once and does not accumulate specialists across rounds.",
      "event.specialists[].issues":
        "bounded: one specialist's verdict issues from one validator turn, capped by the same output guards as the aggregate verdict.",
      "event.specialists[].advisories":
        "bounded: one specialist's non-blocking observations from one validator turn; the immutable round-conclusion event never appends advisories from later rounds.",
      "event.specialists[].sessionRef.backend":
        "tracked: opaque registered agent-backend id for one specialist lane, validated at the backend registry boundary; a single identifier, not a container.",
      "event.specialists[].reviewArtifact.backend":
        "tracked: opaque registered agent-backend id for one specialist review artifact, validated at the backend registry boundary; a single identifier, not a container.",
      "event.specialist.issues":
        "bounded: one specialist's verdict issues from one validator turn, capped by the same output guards as the verdict.",
      "event.specialist.advisories":
        "bounded: one specialist's non-blocking observations from one validator turn; the immutable specialist-settlement event never appends advisories from later rounds.",
      "event.specialist.sessionRef.backend":
        "tracked: opaque registered agent-backend id for the specialist lane, validated at the backend registry boundary; a single identifier, not a container.",
      "event.specialist.reviewArtifact.backend":
        "tracked: opaque registered agent-backend id for the specialist review artifact, validated at the backend registry boundary; a single identifier, not a container.",
      // --- lanes, joins, merges ---
      "event.sourceLaneIds": "bounded: the execution lanes feeding one join.",
      "event.mergedSourceLaneIds":
        "bounded: subset of that join's source lanes.",
      "event.conflicts.**":
        "bounded: the conflicting files of ONE merge attempt plus their per-file resolver analysis, written once when that attempt fails.",
      // --- structural edits (D4) ---
      "event.affectedContextIds":
        "bounded: the contexts one accepted live-edit batch touched; a batch is bounded by its own operation payload, not by edit history.",
      "event.documents":
        "tracked: a whole-registry snapshot of the execution's shared documents at that update — the registry itself grows one entry per workflow-produced document with no eviction (registered as such on graph_workflow_executions.runtime_json.sharedDocuments).",
      // Deliberately three entries rather than one `event.**` subtree: an
      // expansion receipt that grows a FOURTH id array still has to answer here.
      "event.addedContextIds":
        "bounded: the contexts one accepted expansion batch created, capped by the per-request and cumulative expansion caps (D4 decision D5); a refused batch adds none.",
      "event.addedTaskIds":
        "bounded: the tasks one accepted expansion batch created, each belonging to a context in addedContextIds and bounded by the same caps.",
      "event.rejoinContextIds":
        "bounded: the pre-declared rejoin targets of one expansion batch, a deduplicated subset of the contexts downstream of the invoker.",
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

  // R14.2's blob-bounds half. The gate above proves NOTHING escapes it; this
  // proves the D4 inventory and this registry cannot drift apart. Without it a
  // blob-shaped D4 field can be silently absorbed by a subtree discharge added
  // for something else, or quietly stop being a collection, and the inventory's
  // claim that every collection-shaped field is accounted for here goes stale
  // with nothing to notice.
  describe("D4 persisted-field inventory (decision D12)", () => {
    const executionBlob = PERSISTED_BLOBS.find(
      (blob) => blob.schema === graphWorkflowExecutionSchema,
    );
    if (executionBlob === undefined) {
      throw new Error("the execution blob must be registered");
    }
    const collections = describeCollections(graphWorkflowExecutionSchema);
    const inventoryCollections = D4_PERSISTED_FIELDS.filter(
      (field) => field.collection,
    );

    it("finds every collection-flagged inventory field in the blob's collection census", () => {
      const censusPaths = new Set(collections.map((node) => node.path));
      const absent = inventoryCollections
        .filter((field) => !censusPaths.has(field.path))
        .map((field) => field.path);
      expect(
        absent,
        "a field the inventory calls a collection must actually BE one in the persisted schema",
      ).toEqual([]);
    });

    it("gives every collection-flagged inventory field a bound or a declared discharge", () => {
      const unanswered = inventoryCollections.filter((field) => {
        const nodes = collections.filter((node) => node.path === field.path);
        if (nodes.every((node) => node.bounded)) return false;
        return (
          reconcileDischarges(
            nodes.filter((node) => !node.bounded),
            executionBlob.discharges,
          ).undischarged.length > 0
        );
      });
      expect(
        unanswered.map((field) => field.path),
        "every blob-shaped D4 field is either statically capped or declared in this registry",
      ).toEqual([]);
    });
  });

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
