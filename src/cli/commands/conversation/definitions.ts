import { bytes, defineGroup } from "cli-for-agents";
import { CHECKPOINT_CAPTURE_LIMITS } from "@/lib/conversation-checkpoints/budget";
import { ccCommands } from "../../framework/family";

const captureLimitsHelp = `Fixed capture limits: ${CHECKPOINT_CAPTURE_LIMITS.maxSubmissions} submission, ${CHECKPOINT_CAPTURE_LIMITS.executionMs} ms execution, ${CHECKPOINT_CAPTURE_LIMITS.inputBytes} added-input bytes, ${CHECKPOINT_CAPTURE_LIMITS.outputBytes} accepted-output bytes. Capture failure or a reached limit omits handoff after settlement and continues recorded-evidence checkpointing; no capture retry. The ${CHECKPOINT_CAPTURE_LIMITS.settlementMs} ms settlement deadline is not proof execution stopped. Native inspection is bounded at ${CHECKPOINT_CAPTURE_LIMITS.nativeInspectionBytes} bytes and ${CHECKPOINT_CAPTURE_LIMITS.nativeInspectionMs} ms. Cost is checked after the request; no hard dollar or inherited-source-context limit. Valid handoff that cannot fit the seed is omitted whole.`;
const captureModeHelp =
  "Claude uses tool-disabled capture. Codex uses instruction-only capture: tools remain callable, and the agent is asked not to use them. The scoped preflight mode is bound to the attempt; unavailable or changed capability falls back to recorded evidence without changing mode.";

const conversationArgs = [
  {
    name: "conversation-id",
    description:
      "Conversation id; defaults to --conversation or CC_CONVERSATION_ID",
    value: { kind: "string", minLength: 1 },
    required: false,
  },
] as const;
const operationArgs = [
  {
    name: "conversation-id",
    description: "Conversation id",
    value: { kind: "string", minLength: 1 },
  },
  {
    name: "operation-id",
    description: "Checkpoint operation id",
    value: { kind: "string", minLength: 1 },
  },
] as const;
const messageFlag = {
  description:
    "Zero-based message index; omission selects the whole conversation",
  value: { kind: "integer", min: 0 },
} as const;
const formatFlag = {
  description: "Representation of the returned content",
  value: { kind: "enum", values: ["json", "markdown"] },
  default: "json",
} as const;
const recoverFlag = {
  description: "Explicitly recover the named checkpoint operation",
  value: { kind: "string", minLength: 1 },
} as const;

export const readSpec = {
  path: "conversation read",
  summary: "Read a bounded window of original conversation history",
  description:
    "Read original evidence by raw seq or message index. Bare ids can resolve their owning project/session; explicit scope is respected. Omission coordinates distinguish unread messages from shortened entries. Markdown changes content representation, while --json selects the response envelope.",
  requires: "cc",
  effects: "read",
  args: conversationArgs,
  flags: {
    outline: {
      description: "Return message headlines",
      value: { kind: "boolean" },
    },
    message: messageFlag,
    "message-range": {
      description: "Inclusive message indexes A:B (#N headers)",
      value: {
        kind: "pattern",
        pattern: "^[0-9]+:[0-9]+$",
        description: "inclusive A:B range",
      },
    },
    "seq-range": {
      description: "Inclusive original raw seq indexes A:B ([sN] markers)",
      value: {
        kind: "pattern",
        pattern: "^[0-9]+:[0-9]+$",
        description: "inclusive A:B range",
      },
    },
    "include-tools": {
      description: "Tool-result detail",
      value: { kind: "enum", values: ["none", "summary", "full"] },
    },
    "include-thinking": {
      description: "Include recorded thinking blocks",
      value: { kind: "boolean" },
    },
    search: {
      description: "Filter by a regular expression",
      value: { kind: "string" },
    },
    "max-bytes": {
      description: "Maximum rendered transcript bytes",
      value: { kind: "integer", min: 1 },
    },
    format: formatFlag,
  },
  related: [
    {
      path: "conversation entry get",
      description: "Export an entry without excerpts",
    },
    {
      path: "conversation checkpoint list",
      description: "Inspect saved checkpoint boundaries",
    },
  ],
} as const;
export const compactSpec = {
  path: "conversation compact",
  summary: "Generate or refresh a compaction artifact",
  description:
    "Create a background LLM summary without retiring model context. --wait observes for up to five minutes; stopping observation leaves the artifact job running. Mutations use the explicit or ambient scope.",
  requires: "cc",
  effects: "write",
  args: conversationArgs,
  flags: {
    message: messageFlag,
    force: {
      description: "Regenerate even a fresh artifact",
      value: { kind: "boolean" },
    },
    wait: {
      description: "Observe the artifact until completion",
      value: { kind: "boolean" },
    },
  },
  related: [
    {
      path: "conversation compaction get",
      description: "Read the generated summary",
    },
  ],
} as const;
export const compactionGetSpec = {
  path: "conversation compaction get",
  summary: "Read the newest matching compaction artifact",
  description:
    "Inspect status, freshness, and generated content. This read never starts a generation. Missing artifacts carry an explicit create action.",
  requires: "cc",
  effects: "read",
  args: conversationArgs,
  flags: { message: messageFlag, format: formatFlag },
  related: [
    {
      path: "conversation compact",
      description: "Generate or refresh an artifact",
    },
  ],
} as const;
export const compactionListSpec = {
  path: "conversation compaction list",
  summary: "List conversation compaction artifacts",
  description:
    "List recorded summary artifacts with status and coverage. Large results are delivered as an artifact.",
  requires: "cc",
  effects: "read",
  args: conversationArgs,
  flags: {},
} as const;
export const compactContextSpec = {
  path: "conversation compact-context",
  summary: "Start a durable context checkpoint",
  description: `Build a saved context checkpoint in the explicit or ambient scope; another project/session requires --project and, for a session, --session. Without --handoff, send only the baseline start request. --handoff opts into one extra source-agent capture after a read-only scoped capability check, with no extra confirmation. ${captureModeHelp} ${captureLimitsHelp} Admission is not readiness: --wait observes for fifteen minutes and exits 1 for failed, cancelled, reconciliation or observation timeout; stopping observation never cancels execution. --recover explicitly supersedes the named recovery-required operation and does not enable handoff by itself.`,
  requires: "cc",
  effects: "write",
  args: conversationArgs,
  flags: {
    wait: {
      description: "Observe until ready, applied, or a failure phase",
      value: { kind: "boolean" },
    },
    recover: recoverFlag,
    handoff: {
      description:
        "Request one optional source-agent handoff using the disclosed capture mode",
      value: { kind: "boolean" },
    },
  },
  related: [
    {
      path: "conversation checkpoint check",
      description: "Check admission without starting work",
    },
    {
      path: "conversation checkpoint get",
      description: "Read the durable operation receipt",
    },
  ],
} as const;
export const checkpointCheckSpec = {
  path: "conversation checkpoint check",
  summary: "Check checkpoint admission without starting work",
  description: `Read blockers for compact-context or the named --recover operation without starting work. Exit status describes baseline admission; optional handoff capability and its reason are separate. ${captureModeHelp} ${captureLimitsHelp} A blocked check returns findings named by the transition they block. Bare ids may discover ownership; explicit scope is authoritative.`,
  requires: "cc",
  effects: "read",
  args: conversationArgs,
  flags: { recover: recoverFlag },
} as const;
export const checkpointListSpec = {
  path: "conversation checkpoint list",
  summary: "Page through durable checkpoint receipts",
  description:
    "Read a bounded checkpoint index. --before uses the ordinal returned in the next-page cursor.",
  requires: "cc",
  effects: "read",
  args: conversationArgs,
  flags: {
    before: {
      description: "Return checkpoints older than this ordinal",
      value: { kind: "integer", min: 1 },
    },
    limit: {
      description: "Maximum receipts per page (up to 100)",
      value: { kind: "integer", min: 1, max: 100 },
    },
  },
} as const;
export const checkpointGetSpec = {
  path: "conversation checkpoint get",
  summary: "Inspect a durable checkpoint receipt or saved seed",
  description:
    "Read an operation even when its phase is failed. Seed detail includes the complete saved payload and omission accounting; large results are delivered as an artifact.",
  requires: "cc",
  effects: "read",
  args: operationArgs,
  flags: {
    detail: {
      description: "Receipt metadata or the frozen seed",
      value: { kind: "enum", values: ["receipt", "seed"] },
      default: "receipt",
    },
  },
} as const;
export const checkpointCancelSpec = {
  path: "conversation checkpoint cancel",
  summary: "Cancel a cancellable checkpoint operation",
  description:
    "Cancel the whole pre-freeze checkpoint, including capture. Queued input remains held until execution settles. After retirement cancellation cannot restore prior continuity. To omit only capture and continue baseline checkpointing, use skip-handoff. Uses explicit or ambient scope and never repeats a mutation in another scope; inspect the returned receipt.",
  requires: "cc",
  effects: "write",
  args: operationArgs,
  flags: {},
  related: [
    {
      path: "conversation checkpoint get",
      description: "Observe the durable receipt",
    },
    {
      path: "conversation compact-context",
      description: "Explicitly build a recovery checkpoint",
    },
    {
      path: "conversation checkpoint skip-handoff",
      description: "Omit capture and continue baseline checkpointing",
    },
  ],
} as const;
export const checkpointSkipHandoffSpec = {
  path: "conversation checkpoint skip-handoff",
  summary: "Stop optional handoff and continue baseline checkpointing",
  description:
    "Stop and settle optional capture, then continue baseline checkpointing from recorded evidence. To stop the whole pre-freeze checkpoint use cancel. Uses explicit or ambient scope and never retries in a neighboring scope. Stopping records intent, not proof execution stopped: read checkpoint get until settlement. Already settled capture returns handoff_already_settled unchanged.",
  requires: "cc",
  effects: "write",
  args: operationArgs,
  flags: {},
  related: [
    {
      path: "conversation checkpoint get",
      description: "Observe the durable receipt",
    },
    {
      path: "conversation compact-context",
      description: "Explicitly build a recovery checkpoint",
    },
    {
      path: "conversation checkpoint cancel",
      description: "Cancel the whole checkpoint",
    },
  ],
} as const;
export const checkpointReconcileSpec = {
  path: "conversation checkpoint reconcile",
  summary: "Reconcile checkpoint delivery deterministically",
  description:
    "Retry deterministic cleanup and persistence in the explicit or ambient scope, without a model request or neighboring-scope retry. For a capture-cleanup hold only, inspect and stop prior backend work before using --capture-execution-stopped: this records caller testimony, not CC-observed process evidence. Attestation alone never releases queued input or resumes uncertain continuity; the recovery_required refusal retains the updated receipt. Then separately run compact-context --recover <operation-id> for baseline recovery. Unknown seed delivery needs queue review and explicit recovery; the flag cannot clear it.",
  requires: "cc",
  effects: "write",
  args: operationArgs,
  flags: {
    "capture-execution-stopped": {
      description:
        "Attest that you inspected and stopped prior capture execution; records caller testimony, then requires separate recovery",
      value: { kind: "boolean" },
    },
  },
  related: [
    {
      path: "conversation checkpoint get",
      description: "Observe the durable receipt",
    },
    {
      path: "conversation compact-context",
      description: "Explicitly build a recovery checkpoint",
    },
    {
      path: "conversation checkpoint skip-handoff",
      description: "Omit capture and continue baseline checkpointing",
    },
  ],
} as const;
export const checkpointForkSpec = {
  path: "conversation checkpoint fork",
  summary: "Create a conversation draft from a saved checkpoint",
  description:
    "The JSON file supplies requestId, name, task, relatedWork, backend, and modelSelection. The same server preflight powers fork-check and every commit. A created fork remains a draft; backend/model stay editable until first submission.",
  requires: "cc",
  effects: "write",
  args: operationArgs,
  flags: {},
  payload: {
    maxBytes: bytes(256 * 1024),
    validatePath: "conversation checkpoint fork-check",
  },
} as const;
export const entryGetSpec = {
  path: "conversation entry get",
  summary: "Export one complete original archive entry",
  description:
    "Use raw seq indexes, not message indexes. The server returns metadata before the original text body. Thinking is omitted unless requested. Large text is delivered as an artifact; image handles address original bytes.",
  requires: "cc",
  effects: "read",
  args: [
    {
      name: "conversation-id",
      description: "Conversation id",
      value: { kind: "string", minLength: 1 },
    },
    {
      name: "seq",
      description: "Original raw seq index",
      value: { kind: "integer", min: 0 },
    },
  ],
  flags: {
    "include-thinking": {
      description: "Include recorded thinking blocks",
      value: { kind: "boolean" },
    },
  },
} as const;
export const imageGetSpec = {
  path: "conversation image get",
  summary: "Export original image bytes from an archive entry",
  description:
    "Use the image-bearing block index supplied by an entry image handle. The library writes a binary artifact and reports its path, media type, bytes, and digest. --out chooses a destination.",
  requires: "cc",
  effects: "read",
  output: "binary",
  args: [
    {
      name: "conversation-id",
      description: "Conversation id",
      value: { kind: "string", minLength: 1 },
    },
    {
      name: "seq",
      description: "Original raw seq index",
      value: { kind: "integer", min: 0 },
    },
    {
      name: "block-index",
      description: "Image-bearing content block index",
      value: { kind: "integer", min: 0 },
    },
  ],
  flags: {},
} as const;

export const readCommand = ccCommands.defineCommand(readSpec, {
  examples: [
    {
      args: { "conversation-id": "conversation-one" },
      flags: { outline: true },
      why: "Find raw archive coordinates",
    },
  ],
  handler: async () => ({
    default: (await import("./transcript.handler")).readHandler,
  }),
});
export const compactCommand = ccCommands.defineCommand(compactSpec, {
  examples: [
    {
      flags: { wait: true },
      why: "Generate a conversation summary and observe completion",
    },
  ],
  handler: async () => ({
    default: (await import("./transcript.handler")).compactHandler,
  }),
});
export const compactionGetCommand = ccCommands.defineCommand(
  compactionGetSpec,
  {
    examples: [{ why: "Read this conversation's newest summary" }],
    handler: async () => ({
      default: (await import("./transcript.handler")).compactionGetHandler,
    }),
  },
);
export const compactionListCommand = ccCommands.defineCommand(
  compactionListSpec,
  {
    examples: [{ why: "Inspect available summary artifacts" }],
    handler: async () => ({
      default: (await import("./transcript.handler")).compactionListHandler,
    }),
  },
);
export const compactContextCommand = ccCommands.defineCommand(
  compactContextSpec,
  {
    examples: [
      {
        flags: { wait: true },
        why: "Build a checkpoint and observe readiness",
      },
      {
        flags: { handoff: true, wait: true },
        why: "Request one optional handoff and observe the checkpoint, including fallback",
      },
    ],
    handler: async () => ({
      default: (await import("./checkpoint.handler")).compactContextHandler,
    }),
  },
);
export const checkpointCheckCommand = ccCommands.defineCommand(
  checkpointCheckSpec,
  {
    examples: [{ why: "Check whether a checkpoint can start" }],
    handler: async () => ({
      default: (await import("./checkpoint.handler")).checkpointCheckHandler,
    }),
  },
);
export const checkpointListCommand = ccCommands.defineCommand(
  checkpointListSpec,
  {
    examples: [{ flags: { limit: 10 }, why: "Inspect recent checkpoints" }],
    handler: async () => ({
      default: (await import("./checkpoint.handler")).checkpointListHandler,
    }),
  },
);
export const checkpointGetCommand = ccCommands.defineCommand(
  checkpointGetSpec,
  {
    examples: [
      {
        args: {
          "conversation-id": "conversation-one",
          "operation-id": "operation-one",
        },
        why: "Inspect a durable checkpoint receipt",
      },
    ],
    handler: async () => ({
      default: (await import("./checkpoint.handler")).checkpointGetHandler,
    }),
  },
);
export const checkpointCancelCommand = ccCommands.defineCommand(
  checkpointCancelSpec,
  {
    examples: [
      {
        args: {
          "conversation-id": "conversation-one",
          "operation-id": "operation-one",
        },
        why: "Cancel a cancellable operation",
      },
    ],
    handler: async () => ({
      default: (await import("./checkpoint.handler")).checkpointCancelHandler,
    }),
  },
);
export const checkpointSkipHandoffCommand = ccCommands.defineCommand(
  checkpointSkipHandoffSpec,
  {
    examples: [
      {
        args: {
          "conversation-id": "conversation-one",
          "operation-id": "operation-one",
        },
        why: "Skip handoff and continue with recorded evidence",
      },
    ],
    handler: async () => ({
      default: (await import("./checkpoint.handler"))
        .checkpointSkipHandoffHandler,
    }),
  },
);
export const checkpointReconcileCommand = ccCommands.defineCommand(
  checkpointReconcileSpec,
  {
    examples: [
      {
        args: {
          "conversation-id": "conversation-one",
          "operation-id": "operation-one",
        },
        why: "Repair recorded checkpoint delivery",
      },
      {
        args: {
          "conversation-id": "conversation-one",
          "operation-id": "operation-one",
        },
        flags: { "capture-execution-stopped": true },
        why: "After inspecting and stopping prior execution, attest cleanup before separate recovery",
      },
    ],
    handler: async () => ({
      default: (await import("./checkpoint.handler"))
        .checkpointReconcileHandler,
    }),
  },
);
export const checkpointForkCommand = ccCommands.defineCommand(
  checkpointForkSpec,
  {
    examples: [
      {
        args: {
          "conversation-id": "conversation-one",
          "operation-id": "operation-one",
        },
        file: ".cc/temp/fork.json",
        why: "Create a draft from a saved checkpoint",
      },
    ],
    handler: async () => ({
      default: (await import("./fork.handler")).default,
    }),
  },
);
export const entryGetCommand = ccCommands.defineCommand(entryGetSpec, {
  examples: [
    {
      args: { "conversation-id": "conversation-one", seq: 12 },
      why: "Recover a shortened tool result in full",
    },
  ],
  handler: async () => ({
    default: (await import("./evidence.handler")).entryGetHandler,
  }),
});
export const imageGetCommand = ccCommands.defineCommand(imageGetSpec, {
  examples: [
    {
      args: {
        "conversation-id": "conversation-one",
        seq: 12,
        "block-index": 1,
      },
      why: "Save an original archived image",
    },
  ],
  handler: async () => ({
    default: (await import("./evidence.handler")).imageGetHandler,
  }),
});
export const conversationCommands = [
  readCommand,
  compactCommand,
  compactionGetCommand,
  compactionListCommand,
  compactContextCommand,
  checkpointCheckCommand,
  checkpointListCommand,
  checkpointGetCommand,
  checkpointCancelCommand,
  checkpointSkipHandoffCommand,
  checkpointReconcileCommand,
  checkpointForkCommand,
  entryGetCommand,
  imageGetCommand,
] as const;
export const conversationGroups = [
  defineGroup({
    path: "conversation",
    summary: "Read original history and manage context checkpoints",
    description:
      "Window history, recover original evidence, generate summaries, or manage durable checkpoints.",
  }),
  defineGroup({
    path: "conversation compaction",
    summary: "Inspect summary artifacts",
    description: "Get or list summary artifacts without generating new work.",
  }),
  defineGroup({
    path: "conversation checkpoint",
    summary: "Manage durable context checkpoints",
    description:
      "Check admission and capture capability, page receipts, inspect frozen seeds, skip optional handoff, or explicitly cancel, reconcile and fork operations.",
  }),
  defineGroup({
    path: "conversation entry",
    summary: "Recover original archive entries",
    description: "Export original text using raw sequence coordinates.",
  }),
  defineGroup({
    path: "conversation image",
    summary: "Recover original archive images",
    description: "Save original bytes using archive image handles.",
  }),
] as const;
