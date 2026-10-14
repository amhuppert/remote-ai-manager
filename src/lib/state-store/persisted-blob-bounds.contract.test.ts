import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compactionEnvelopeSchema } from "@/lib/context-artifacts/schemas";
import { checkpointPayloadSchema } from "@/lib/conversation-checkpoints/schemas";
import { conversationStateSchema } from "@/lib/conversations/schemas";
import { memoryNoteSchema } from "@/lib/memory/schemas";
import { sessionStateSchema } from "@/lib/sessions/schemas";
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
      "checkpointFork.initialSelection.modelSelection.parameters":
        "bounded: one immutable selection admitted by fork-service against the backend's model catalog; at most one value per declared parameter, never accumulated across turns.",
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
        "pruned: migration-only legacy storage; ordered migration 0061 imports these entries into durable inbox receipts and clears the array. Production has no append path.",
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
  {
    label: "conversation_checkpoints sections_json + omissions_json",
    schema: checkpointPayloadSchema,
    discharges: {
      "sections.workingState":
        "tracked: the seed builder owns the structured section shapes and validates them before offering a payload; storage stores the bytes it validated and the BEFORE UPDATE trigger forbids appending to them.",
      "sections.recentDialogue":
        "tracked: the seed builder owns the structured section shapes and validates them before offering a payload; storage stores the bytes it validated and the BEFORE UPDATE trigger forbids appending to them.",
      "sections.recoveryMap":
        "tracked: the seed builder owns the structured section shapes and validates them before offering a payload; storage stores the bytes it validated and the BEFORE UPDATE trigger forbids appending to them.",
      "omissions.**":
        "bounded: one immutable payload inserted once per operation, recording what a single bounded build dropped; the payload has no update API and the BEFORE UPDATE trigger aborts any write, so the list cannot grow after the freeze.",
      "modelSelection.parameters":
        "bounded: one backend's declared model parameters for a single resolved selection, keyed by the registered parameter ids that backend exposes; a selection carries at most one value per parameter.",
    },
  },
  {
    // `memory_note_revisions.snapshot_json` holds one whole Memory Note per
    // revision. Its only collection is the alias list, which the domain schema
    // caps statically, so the snapshot cannot grow a column-rewriting tail.
    label: "memory_note_revisions snapshot",
    schema: memoryNoteSchema,
    discharges: {},
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
