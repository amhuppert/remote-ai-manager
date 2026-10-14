import { bytes } from "cli-for-agents";
import { ccCommands } from "../../framework/family";

const subscriptionId = {
  name: "subscription-id",
  description: "Stable subscription id from subscription list or subscribe",
  value: {
    kind: "pattern",
    pattern: "^\\S+$",
    description: "non-whitespace subscription id",
  },
} as const;
const expiresIn = {
  description:
    "New active wait lifetime in seconds (default 24 hours, maximum 7 days); retained wait expiry is immutable",
  value: { kind: "integer", min: 1, max: 604800 },
} as const;
const mode = { kind: "enum", values: ["passive", "active"] } as const;
const detailEdge = {
  path: "subscription get",
  description: "Inspect one subscription and its wait evidence",
} as const;

export const subscriptionCatalogSpec = {
  path: "subscription catalog",
  summary: "Discover subscription sources, event kinds and supported modes",
  description:
    "Read the small source catalog with exact source identity requirements, supported event ids and passive or active capabilities. The catalog needs server credentials, but no conversation identity. Active mode observes only finite terminal-source waits.",
  requires: "cc",
  effects: "read",
  args: [],
  flags: {},
  related: [
    {
      path: "subscription subscribe",
      description: "Subscribe to an exact source from the catalog",
    },
  ],
} as const;

export const subscriptionSubscribeSpec = {
  path: "subscription subscribe",
  summary: "Explicitly subscribe this conversation to an exact source",
  description:
    "Create or update a durable subscription for the addressed ordinary conversation. Passive mode waits for the next user message. Active mode registers a finite terminal wait for validation runs or git jobs and returns immediately; it does not poll or transfer a validation submitter lease. Active lifetime defaults to 24 hours and is limited to 7 days. This explicit request restores a general opt-out with a current source baseline and resumes delivery. A live finite wait keeps its reason and expiry. After settlement or cancellation, an undelivered terminal result remains obtainable. A consumed final result is refused instead of creating an ineffective wait.",
  requires: "cc",
  effects: "write",
  args: [
    {
      name: "kind",
      description: "Source kind from subscription catalog",
      value: {
        kind: "enum",
        values: ["notepad", "ticket", "spec", "run", "validation", "git_job"],
      },
    },
    {
      name: "source-id",
      description: "Exact source id in the catalog's identity format",
      value: {
        kind: "pattern",
        pattern: "^\\S{1,256}$",
        description: "non-whitespace source id, at most 256 characters",
      },
    },
  ],
  flags: {
    reason: {
      description: "Why this conversation needs source updates",
      value: { kind: "string", minLength: 1, maxLength: 1000 },
      required: true,
      fileSource: { maxBytes: bytes(4000) },
    },
    mode: {
      description: "Passive inbox updates or a finite active terminal wait",
      value: mode,
      default: "passive",
    },
    "event-kind": {
      description:
        "Event id from subscription catalog; repeat to select several (default all supported events)",
      value: { kind: "string", minLength: 1 },
      repeatable: true,
    },
    "expires-in": expiresIn,
  },
  related: [
    {
      path: "subscription catalog",
      description: "Discover identities and supported event ids",
    },
    detailEdge,
    {
      path: "subscription list",
      description: "Find existing follows and opt-outs",
    },
  ],
} as const;

export const subscriptionGetSpec = {
  path: "subscription get",
  summary: "Inspect one subscription, finite wait and wake batch",
  description:
    "Read the subscription's reason, mode, pause and opt-out state, source cursor and errors. Finite waits include their outcome and wake batch. This read neither reconciles sources nor acknowledges delivery. Runtime acceptance does not prove agent action.",
  requires: "cc",
  effects: "read",
  args: [subscriptionId],
  flags: {},
  related: [
    { path: "subscription list", description: "Find stable subscription ids" },
    {
      path: "subscription pause",
      description: "Hold delivery while retaining source outcomes",
    },
    {
      path: "subscription mode",
      description: "Change passive or active delivery",
    },
    { path: "inbox get", description: "Inspect one saved delivery" },
  ],
} as const;

export const subscriptionPauseSpec = {
  path: "subscription pause",
  summary: "Pause delivery and waking for one subscription",
  description:
    "Hold delivery and active wake dispatch while source collection and finite expiry continue. The server safely withdraws a pending wake or an unsent planned batch; a delivering or ambiguous wake requires queue review. Accepted turns cannot be recalled. Recorded source outcomes remain inspectable.",
  requires: "cc",
  effects: "write",
  args: [subscriptionId],
  flags: {},
  related: [
    detailEdge,
    {
      path: "subscription resume",
      description: "Resume delivery of retained source outcomes",
    },
  ],
} as const;
export const subscriptionResumeSpec = {
  path: "subscription resume",
  summary: "Resume one paused subscription",
  description:
    "Resume delivery and active dispatch of retained source outcomes. Source collection and finite expiry continue during a pause. Resuming does not recreate a cancelled finite wait or clear a public source's remembered opt-out. Internal own-conversation notice sources resume passive following after an opt-out.",
  requires: "cc",
  effects: "write",
  args: [subscriptionId],
  flags: {},
  related: [
    detailEdge,
    {
      path: "subscription pause",
      description: "Hold delivery while retaining source outcomes",
    },
  ],
} as const;
export const subscriptionModeSpec = {
  path: "subscription mode",
  summary: "Change one subscription's passive or active mode",
  description:
    "Change delivery mode for an existing subscription. Active mode is limited to finite terminal waits for exact validation runs and git jobs; a new wait defaults to 24 hours. Mode changes preserve pause state and a live wait's reason, expiry and outcome. Passive mode safely withdraws pending or unsent planned wakes; delivering or ambiguous wakes require queue review. After settlement or cancellation, active mode can create a new wait generation for an undelivered outcome. A consumed final result is refused with ACTIVE_WAIT_SOURCE_FINAL.",
  requires: "cc",
  effects: "write",
  args: [
    subscriptionId,
    { name: "mode", description: "Delivery mode to apply", value: mode },
  ],
  flags: { "expires-in": expiresIn },
  related: [
    detailEdge,
    {
      path: "subscription catalog",
      description: "Inspect which source kinds permit active mode",
    },
  ],
} as const;
export const subscriptionCancelSpec = {
  path: "subscription cancel",
  summary: "Cancel one finite active wait",
  description:
    "Cancel one finite wait and restore passive following without recording an opt-out. Pending wakes or unsent planned batches can be safely withdrawn; delivering, failed or ambiguous wakes require queue review. An uncertain wake permits cancellation when the server proves no queue row or accepted transcript receipt exists. Other pending batch members remain ready to batch again. Accepted turns cannot be recalled. Use unfollow for a general remembered opt-out.",
  requires: "cc",
  effects: "write",
  args: [subscriptionId],
  flags: {},
  related: [
    detailEdge,
    {
      path: "subscription unfollow",
      description: "Remember a general source opt-out",
    },
  ],
} as const;
export const inboxSummarySpec = {
  path: "inbox summary",
  summary: "Read recorded pending counts and the advisory hint preference",
  description:
    "Read this ordinary conversation's recorded pending count and durable hint preference without reconciling sources, acknowledging input or marking human read state. Pending contents are disclosed only by explicit inbox inspection.",
  requires: "cc",
  effects: "read",
  args: [],
  flags: {},
  related: [
    {
      path: "inbox list",
      description: "Inspect a bounded page of pending updates",
    },
    {
      path: "inbox hints",
      description: "Enable or disable advisory inbox hints",
    },
  ],
} as const;
export const inboxHintsSpec = {
  path: "inbox hints",
  summary: "Enable or disable advisory inbox hints for this conversation",
  description:
    "Persist the conversation's advisory hint preference, which defaults to on. Hints disclose only a pending count and an inbox inspection command; they never deliver or acknowledge update contents. Use inbox summary to inspect the current preference.",
  requires: "cc",
  effects: "write",
  args: [
    {
      name: "state",
      description: "Whether to show advisory inbox hints",
      value: { kind: "enum", values: ["on", "off"] },
    },
  ],
  flags: {},
  related: [
    {
      path: "inbox summary",
      description: "Inspect counts and the current preference",
    },
  ],
} as const;

export const subscriptionCatalogCommand = ccCommands.defineCommand(
  subscriptionCatalogSpec,
  {
    examples: [
      { why: "Discover valid source identities before explicit registration" },
    ],
    handler: async () => ({
      default: (await import("./controls-handlers")).catalogHandler,
    }),
  },
);
export const subscriptionSubscribeCommand = ccCommands.defineCommand(
  subscriptionSubscribeSpec,
  {
    examples: [
      {
        args: { kind: "notepad", "source-id": "notepad-one" },
        flags: {
          reason: "Track decisions",
          "event-kind": ["notepad-content-revised"],
        },
        why: "Select the catalog's revision event in passive mode",
      },
      {
        args: { kind: "run", "source-id": "run-one" },
        flags: { reason: "Track run progress", mode: "passive" },
        why: "Follow run boundaries within this project",
      },
      {
        args: { kind: "validation", "source-id": "validation-one" },
        flags: {
          reason: "Continue after validation",
          mode: "active",
          "expires-in": 3600,
        },
        why: "Register a finite terminal wait without blocking",
      },
    ],
    handler: async () => ({
      default: (await import("./controls-handlers")).subscribeHandler,
    }),
  },
);
export const subscriptionGetCommand = ccCommands.defineCommand(
  subscriptionGetSpec,
  {
    examples: [
      {
        args: { "subscription-id": "subscription-one" },
        why: "Inspect source state separately from wake acceptance evidence",
      },
    ],
    handler: async () => ({
      default: (await import("./controls-handlers")).getHandler,
    }),
  },
);
export const subscriptionPauseCommand = ccCommands.defineCommand(
  subscriptionPauseSpec,
  {
    examples: [
      {
        args: { "subscription-id": "subscription-one" },
        why: "Keep the cursor while holding future source updates",
      },
    ],
    handler: async () => ({
      default: (await import("./controls-handlers")).pauseHandler,
    }),
  },
);
export const subscriptionResumeCommand = ccCommands.defineCommand(
  subscriptionResumeSpec,
  {
    examples: [
      {
        args: { "subscription-id": "subscription-one" },
        why: "Collect again from a paused subscription's retained cursor",
      },
    ],
    handler: async () => ({
      default: (await import("./controls-handlers")).resumeHandler,
    }),
  },
);
export const subscriptionModeCommand = ccCommands.defineCommand(
  subscriptionModeSpec,
  {
    examples: [
      {
        args: { "subscription-id": "subscription-one", mode: "active" },
        flags: { "expires-in": 3600 },
        why: "Wake once for an exact terminal source with a finite lifetime",
      },
    ],
    handler: async () => ({
      default: (await import("./controls-handlers")).modeHandler,
    }),
  },
);
export const subscriptionCancelCommand = ccCommands.defineCommand(
  subscriptionCancelSpec,
  {
    examples: [
      {
        args: { "subscription-id": "subscription-one" },
        why: "Cancel an unbatched finite wait after inspecting its state",
      },
    ],
    handler: async () => ({
      default: (await import("./controls-handlers")).cancelHandler,
    }),
  },
);
export const inboxSummaryCommand = ccCommands.defineCommand(inboxSummarySpec, {
  examples: [
    {
      why: "Inspect the recorded count and preference without collecting sources",
    },
  ],
  handler: async () => ({
    default: (await import("./controls-handlers")).inboxSummaryHandler,
  }),
});
export const inboxHintsCommand = ccCommands.defineCommand(inboxHintsSpec, {
  examples: [
    {
      args: { state: "off" },
      why: "Disable optional count hints while retaining explicit inbox inspection",
    },
  ],
  handler: async () => ({
    default: (await import("./controls-handlers")).inboxHintsHandler,
  }),
});
export const subscriptionControlCommands = [
  subscriptionCatalogCommand,
  subscriptionSubscribeCommand,
  subscriptionGetCommand,
  subscriptionPauseCommand,
  subscriptionResumeCommand,
  subscriptionModeCommand,
  subscriptionCancelCommand,
  inboxSummaryCommand,
  inboxHintsCommand,
];
