import { checkpointLifecycleRefusalCodeSchema } from "@/lib/conversation-checkpoints/admission";

import type { CommandHelpEntry } from "../../help-types";

/**
 * Help-registry entries for the checkpoint and evidence leaves of `cctl
 * conversation` (design §8; R8.2, R8.6–R8.10).
 *
 * Everything an agent must know offline lives here, because the entry IS the
 * contract: the flag allowlist, the parse-time boolean set, the group's verb
 * list, and the portable command reference all derive from these objects. Two
 * distinctions get repeated deliberately in the leaves that depend on them —
 * READY (a checkpoint waiting for the next message) versus APPLIED (the next
 * message accepted it), and raw SEQ coordinates versus message indexes —
 * because acting on the wrong one is the failure the help exists to prevent.
 */

/**
 * The blocker vocabulary a preflight can report, taken from the admission
 * schema rather than retyped. An agent learns the identifiers offline, and the
 * list cannot fall behind the predicates that actually refuse — the failure a
 * hand-written excerpt of an enum always eventually has.
 */
const BLOCKER_VOCABULARY =
  `Blocker codes are stable vocabulary, and every refusal carries its own remedy: ${checkpointLifecycleRefusalCodeSchema.options.join(", ")}. ` +
  "Two are policy rather than state: conversation_owned means a workflow or collaboration owns this conversation's turns, and queue_review_required means a queued delivery's outcome is unknown, which CC never resolves by replaying it for you.";

const SCOPE_NOTE =
  "Scope: the mutation targets your ambient project/session. Acting on a conversation elsewhere requires --project (and --session for a session conversation); cctl never discovers another owning scope and writes there for you.";

export const conversationCheckpointHelpEntries: CommandHelpEntry[] = [
  ...(["fork-check", "fork"] as const).map(
    (verb): CommandHelpEntry => ({
      path: ["conversation", "checkpoint", verb],
      dynamicContext: true,
      summary:
        verb === "fork"
          ? "create a focused conversation from a saved checkpoint"
          : "check checkpoint fork admission without creating a conversation",
      description:
        "Use an immutable saved checkpoint to seed an ordinary conversation in the source scope. No model request runs at creation: the task is an editable draft. Backend/model can change until first submission, including across providers. Related work is a context reference and grants no workflow ownership. " +
        SCOPE_NOTE,
      usage: [
        `cctl conversation checkpoint ${verb} <conversation-id> <operation-id> --file <request.json> [--json]`,
      ],
      flags: [
        {
          name: "file",
          kind: "value",
          valuePlaceholder: "<request.json>",
          description: "JSON request; locally validated before connecting",
        },
      ],
      examples: [
        {
          invocation: `cctl conversation checkpoint ${verb} conv-1 op-1 --file fork.json`,
          explanation:
            verb === "fork"
              ? "create or rejoin the fork using the file's stable requestId"
              : "read-only check of the same request and scope used for creation",
        },
      ],
      domainContext:
        'Request: {"requestId":"<UUID>","name":"Next phase","task":"Implement the next task","relatedWork":{"kind":"ticket","ticketNumber":131},"backend":"codex","modelSelection":{"modelId":"gpt-6-astra","parameters":{}}}. Supply the complete atomic selection from the project model catalog. Other relatedWork shapes: {kind:"spec_task",specId,elementId,revisionId}, or {kind:"workflow_assignment",executionId,sessionName,owner:{kind:"workflow"}|{kind:"context",contextId}|{kind:"loop_template",loopGroupId,contextId},assignmentId,useSite:"implementer"|"validator"}. Reuse the identical file after a lost response; changing its body with the same requestId is refused. A session fork shares the current worktree; it restores no files and transfers no provider-private reasoning.',
      related: [
        {
          command: "conversation checkpoint get",
          oneLiner: "inspect saved seed and lineage",
        },
      ],
    }),
  ),

  {
    path: ["conversation", "compact-context"],
    dynamicContext: true,
    summary: "start a CC checkpoint that retires this conversation's context",
    description:
      "Freeze a bounded continuation seed, retire the conversation's provider context, and leave the seed READY for the next ordinary message to accept. This is a lifecycle action on the live conversation — distinct from `conversation compact`, which only writes a reading artifact and changes no context. Without --wait it returns as soon as the operation is durable, reporting its ACTUAL phase (building) and never claiming readiness. With --wait it observes the durable operation to ready/applied (exit 0) or failure/cancellation/reconciliation/timeout (exit 1); a client timeout leaves the server's work running and names the exact command that reads it. " +
      SCOPE_NOTE,
    usage: [
      "cctl conversation compact-context [<conversation-id>] [--wait] [--recover <operation-id>] [--json]",
    ],
    flags: [
      {
        name: "wait",
        kind: "boolean",
        description:
          "observe the operation until ready/applied instead of returning at admission",
      },
      {
        name: "recover",
        kind: "value",
        valuePlaceholder: "<operation-id>",
        description:
          "supersede a named recovery-required operation and rebuild from the recorded archive",
      },
    ],
    examples: [
      {
        invocation: "cctl conversation compact-context --wait",
        explanation:
          "checkpoint your own conversation and block until the seed is READY — ready means the NEXT message will accept it, not that anything was applied yet",
      },
      {
        invocation:
          "cctl conversation compact-context 0197a3c2-... --recover 3f5c1e64-... --project cc --session my-session",
        explanation:
          "explicit recovery of a blocked operation in another session: --recover names the operation being superseded, and the scope flags are required because this is a mutation",
      },
    ],
    domainContext:
      "READY and APPLIED are different states. Ready means the frozen seed is waiting; the next ordinary user message delivers it once and the operation becomes applied. Building the seed DOES use model work — a working-state pass, plus any repair pass it needs, whose measured cost the receipt reports as compaction usage — but that work adds no ordinary turn to the source conversation, names no assistant message and consumes no queued message.",
    related: [
      {
        command: "conversation checkpoint check",
        oneLiner: "read the admission predicates before starting",
      },
      {
        command: "conversation checkpoint get",
        oneLiner: "read the operation this returns",
      },
      {
        command: "conversation compact",
        oneLiner:
          "the reading artifact instead — no context change, no retirement",
      },
    ],
  },
  {
    path: ["conversation", "checkpoint"],
    dynamicContext: true,
    summary: "inspect and repair conversation checkpoint operations",
    description:
      "Read checkpoint eligibility and receipts, and act on an operation that is stuck. Reads resolve a conversation by id in either scope; cancel and reconcile are mutations and stay in your ambient scope unless you pass --project/--session.",
    usage: [
      "cctl conversation checkpoint <check|list|get|cancel|reconcile|fork-check|fork>",
    ],
    flags: [],
    examples: [],
    related: [
      {
        command: "conversation compact-context",
        oneLiner: "start the operation these verbs inspect",
      },
    ],
  },
  {
    path: ["conversation", "checkpoint", "check"],
    dynamicContext: true,
    summary: "report whether a checkpoint would be admitted right now",
    description:
      "Read-only preflight: it evaluates the SAME admission predicates `compact-context` enforces and lists every blocker with its stable code, the transition it blocks (blocks_compact_context, or blocks_recovery when --recover names an operation), and a remedy. It creates no operation, no request UUID, starts no generation, drains no queue and changes nothing durable. Exit 0 when the named transition is eligible, exit 1 when a lifecycle or backend blocker stands. It is a point-in-time answer: the real transition rechecks under its own serialized boundary, so a clean check does not promise the build will succeed.",
    usage: [
      "cctl conversation checkpoint check [<conversation-id>] [--recover <operation-id>] [--json]",
    ],
    flags: [
      {
        name: "recover",
        kind: "value",
        valuePlaceholder: "<operation-id>",
        description:
          "check the named explicit recovery instead of an ordinary checkpoint",
      },
    ],
    examples: [
      {
        invocation: "cctl conversation checkpoint check",
        explanation:
          "before starting: exit 0 prints `eligible: compact_context`, exit 1 lists each blocker code with the transition it blocks and its remedy",
      },
      {
        invocation:
          "cctl conversation checkpoint check 0197a3c2-... --recover 3f5c1e64-...",
        explanation:
          "check the named recovery instead — a mismatched operation id is refused with recovery_target_mismatch rather than silently checked as an ordinary start",
      },
    ],
    domainContext: BLOCKER_VOCABULARY,
    related: [
      {
        command: "conversation compact-context",
        oneLiner: "the transition this preflight reports on",
      },
      {
        command: "conversation checkpoint get",
        oneLiner: "read the operation a checkpoint_pending blocker names",
      },
    ],
  },
  {
    path: ["conversation", "checkpoint", "list"],
    dynamicContext: true,
    summary: "list a conversation's checkpoint receipts, newest first",
    description:
      "Receipts in descending ordinal, 20 per page and 100 at most. Never carries seed text or provider references. When a page is capped the output states total/returned/truncated and the exact `--before <ordinal>` command that reads the next page, in text and in JSON alike.",
    usage: [
      "cctl conversation checkpoint list [<conversation-id>] [--before <ordinal>] [--limit <n>] [--json]",
    ],
    flags: [
      {
        name: "before",
        kind: "value",
        valuePlaceholder: "<ordinal>",
        description:
          "return ordinals strictly below this one (the page cursor)",
      },
      {
        name: "limit",
        kind: "value",
        valuePlaceholder: "<n>",
        description: "rows per page, 1–100 (default 20)",
      },
    ],
    examples: [
      {
        invocation: "cctl conversation checkpoint list 0197a3c2-...",
        explanation:
          "the newest 20 receipts with their operation ids, ordinals and phases; the operation id is what get/cancel/reconcile take",
      },
      {
        invocation:
          "cctl conversation checkpoint list 0197a3c2-... --before 12 --limit 5",
        explanation:
          "the page below ordinal 12 — copy the `--before` value from the previous page's omission line rather than guessing it",
      },
    ],
    related: [
      {
        command: "conversation checkpoint get",
        oneLiner: "read one listed receipt in full",
      },
    ],
  },
  {
    path: ["conversation", "checkpoint", "get"],
    dynamicContext: true,
    summary: "read one checkpoint receipt, or its exact frozen seed",
    description:
      "The receipt: phase, ordinal, source boundary, seed hash and section byte counts, omission categories, compaction pass count and measured compaction usage, delivery/acceptance evidence and any failure. --detail seed additionally returns the exact frozen seed text — the only disclosure of it anywhere. Reading succeeds (exit 0) even when the operation FAILED: the phase and failure stay explicit in the output rather than becoming an exit code.",
    usage: [
      "cctl conversation checkpoint get <conversation-id> <operation-id> [--detail receipt|seed] [--json]",
    ],
    flags: [
      {
        name: "detail",
        kind: "value",
        valuePlaceholder: "receipt|seed",
        description:
          "receipt (default) or seed — seed adds the exact frozen bytes",
      },
    ],
    examples: [
      {
        invocation:
          "cctl conversation checkpoint get 0197a3c2-... 3f5c1e64-...",
        explanation:
          "phase, boundary, byte counts and omissions; `applied` means an ordinary turn accepted the seed, `ready` means one has not yet",
      },
      {
        invocation:
          "cctl conversation checkpoint get 0197a3c2-... 3f5c1e64-... --detail seed",
        explanation:
          "the exact injected seed; past the stdout budget it is written under .cc/temp/ and stdout carries the path, bytes and sha256 instead",
      },
    ],
    related: [
      {
        command: "conversation checkpoint list",
        oneLiner: "find the operation id this takes",
      },
      {
        command: "conversation entry get",
        oneLiner: "the original archive evidence behind a seed's source refs",
      },
    ],
  },
  {
    path: ["conversation", "checkpoint", "cancel"],
    dynamicContext: true,
    summary: "cancel an in-flight checkpoint operation",
    description:
      "Cancel an operation that has not retired the conversation's context yet; the original runtime and history are preserved. An operation past that point is refused with not_cancellable and its actual phase. Returns the receipt with the next action either way. " +
      SCOPE_NOTE,
    usage: [
      "cctl conversation checkpoint cancel <conversation-id> <operation-id> [--json]",
    ],
    flags: [],
    examples: [
      {
        invocation:
          "cctl conversation checkpoint cancel 0197a3c2-... 3f5c1e64-...",
        explanation:
          "stop a build you no longer want; a refusal names the phase it had already reached",
      },
    ],
    related: [
      {
        command: "conversation checkpoint reconcile",
        oneLiner: "repair a stuck operation instead of cancelling it",
      },
    ],
  },
  {
    path: ["conversation", "checkpoint", "reconcile"],
    dynamicContext: true,
    summary: "retry the deterministic repair of a stuck checkpoint operation",
    description:
      "Deterministic repair only: it re-runs owned close, persistence and attempt-correlated receipt work, and never sends a model request or replays a message. When delivery remains UNKNOWN it stays blocked and says so — resolve the uncertain queued entries first, then supersede the operation with `compact-context --recover <operation-id>`, which rebuilds from the recorded archive. Neither reconcile nor recovery undoes tool effects, files or provider-side state. " +
      SCOPE_NOTE,
    usage: [
      "cctl conversation checkpoint reconcile <conversation-id> <operation-id> [--json]",
    ],
    flags: [],
    examples: [
      {
        invocation:
          "cctl conversation checkpoint reconcile 0197a3c2-... 3f5c1e64-...",
        explanation:
          "finish the deterministic half of a needs_reconciliation operation; if it stays blocked the output names the remaining uncertainty and the recovery command",
      },
    ],
    related: [
      {
        command: "conversation compact-context",
        oneLiner: "supersede a blocked operation with --recover",
      },
      {
        command: "conversation checkpoint get",
        oneLiner: "re-read the operation after a repair",
      },
    ],
  },
  {
    path: ["conversation", "entry"],
    dynamicContext: true,
    summary: "export one complete archive entry",
    description:
      "Original conversation evidence at a raw sequence coordinate, without the reader's presentation limits.",
    usage: ["cctl conversation entry <get>"],
    flags: [],
    examples: [],
    related: [
      {
        command: "conversation read",
        oneLiner: "the bounded window whose elisions name these coordinates",
      },
    ],
  },
  {
    path: ["conversation", "entry", "get"],
    dynamicContext: true,
    summary: "export one complete archive entry at a raw sequence",
    description:
      "The complete normalized entry at raw sequence <seq>, with FULL tool detail and no excerpt limits — this is what recovers a tool result the reader summarized. <seq> is a raw JSONL line coordinate ([sN] in read output), not a #N message index. Thinking blocks are omitted unless --include-thinking. Past the shared stdout budget the export is written under the invoking worktree's .cc/temp/ and stdout carries its path, byte count and sha256 with a bounded read instruction, so a huge tool result survives the round trip instead of truncating a pipe.",
    usage: [
      "cctl conversation entry get <conversation-id> <seq> [--include-thinking] [--json]",
    ],
    flags: [
      {
        name: "include-thinking",
        kind: "boolean",
        description: "include thinking blocks (default off)",
      },
    ],
    examples: [
      {
        invocation: "cctl conversation entry get 0197a3c2-... 148",
        explanation:
          "148 is a raw seq from a [s148] marker or a read's truncation follow-up — a #N message index here addresses a different line",
      },
      {
        invocation:
          "cctl conversation entry get 0197a3c2-... 148 --include-thinking",
        explanation:
          "recovers a thinking excerpt the reader clipped; without the flag the export reports how many thinking blocks it left out",
      },
    ],
    domainContext:
      "Two coordinate systems: [sN] markers are raw sequences (entry get, --seq-range) and #N headers are message indexes (--message-range). An image inside an entry is addressed by that entry's seq PLUS the image-bearing content block index the export lists.",
    related: [
      {
        command: "conversation image get",
        oneLiner: "the original bytes of an image this entry lists",
      },
      {
        command: "conversation read",
        oneLiner: "the bounded window that named this coordinate",
      },
    ],
  },
  {
    path: ["conversation", "image"],
    dynamicContext: true,
    summary: "materialize an archived image",
    description:
      "Original image bytes at an archive coordinate, written to a file rather than embedded in stdout.",
    usage: ["cctl conversation image <get>"],
    flags: [],
    examples: [],
    related: [
      {
        command: "conversation entry get",
        oneLiner: "list the image handles an entry carries",
      },
    ],
  },
  {
    path: ["conversation", "image", "get"],
    dynamicContext: true,
    summary: "write an archived image to a file and report its hash",
    description:
      "Resolve the image at <seq> <block-index> from the archive and write its ORIGINAL bytes under the invoking worktree's .cc/temp/, printing the path, media type, byte count and sha256. Never base64 in stdout. <block-index> is the image-bearing content block index inside that entry, exactly as `entry get` lists it; a paired marker/reference is one image at the reference's index. Inline and externalized images recover through the same coordinate, and a missing asset is reported as asset_unavailable with the handle intact.",
    usage: [
      "cctl conversation image get <conversation-id> <seq> <block-index> [--json]",
    ],
    flags: [],
    examples: [
      {
        invocation: "cctl conversation image get 0197a3c2-... 148 2",
        explanation:
          "148 is the entry's raw seq and 2 the image-bearing content block index — copy both from the entry export rather than counting blocks by eye; open the printed path with your image viewer",
      },
    ],
    related: [
      {
        command: "conversation entry get",
        oneLiner: "the entry whose handles name this coordinate",
      },
    ],
  },
];
