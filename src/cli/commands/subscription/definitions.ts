import { bytes, defineGroup } from "cli-for-agents";
import { ccCommands } from "../../framework/family";
import { subscriptionControlCommands } from "./controls-definitions";

const paging = {
  limit: {
    description: "Maximum rows to return",
    value: { kind: "integer", min: 1, max: 200 },
    default: 20,
  },
  offset: {
    description: "Rows to skip from the current result",
    value: { kind: "integer", min: 0 },
    default: 0,
  },
} as const;

const subscriptionId = {
  name: "subscription-id",
  description: "Stable subscription id from subscription waits or list",
  value: {
    kind: "pattern",
    pattern: "^\\S+$",
    description: "non-whitespace subscription id",
  },
} as const;

export const subscriptionWaitSpec = {
  path: "subscription wait",
  summary: "Register a terminal wait and return immediately",
  description:
    "Wait for the exact validation run or git job to reach a terminal state. Registration returns the durable wait id and state immediately; it does not block or poll. The server schedules an ordinary conversation turn with the result. The lifetime defaults to 24 hours and is limited to 7 days. A live wait retains its deadline; paused, passive or unfollowed controls require explicit restoration. After settlement or cancellation, an undelivered terminal result remains obtainable. A consumed final result is refused instead of creating an ineffective wait. A validation wait does not detach the run or renew its private submitter lease; lease interruption is a terminal result. Managed conversations cannot register waits.",
  requires: "cc",
  effects: "write",
  args: [
    {
      name: "kind",
      description: "Terminal source kind",
      value: { kind: "enum", values: ["validation", "git_job"] },
    },
    {
      name: "source-id",
      description: "Exact execution, validation run or git job id",
      value: {
        kind: "pattern",
        pattern: "^\\S+$",
        description: "non-whitespace source id",
      },
    },
  ],
  flags: {
    reason: {
      description: "Why this conversation needs the terminal result",
      value: { kind: "string", minLength: 1, maxLength: 1000 },
      required: true,
      fileSource: { maxBytes: bytes(4000) },
    },
    "expires-in": {
      description:
        "Wait lifetime in seconds (default 24 hours, maximum 7 days)",
      value: { kind: "integer", min: 1, max: 604800 },
      default: 86400,
    },
  },
  related: [
    {
      path: "subscription waits",
      description: "Inspect registered waits and their states",
    },
    {
      path: "subscription wait-get",
      description: "Inspect one wait and its wake delivery",
    },
  ],
} as const;

export const subscriptionWaitsSpec = {
  path: "subscription waits",
  summary: "Inspect this conversation's terminal waits",
  description:
    "List a bounded page of durable terminal waits, including settled and cancelled records. Each row names its subscription id and a detail command. A terminal source result alone does not prove that the wake turn was accepted; use wait-get to inspect the batch and delivery.",
  requires: "cc",
  effects: "read",
  args: [],
  flags: paging,
  related: [
    {
      path: "subscription wait",
      description: "Register an exact terminal source wait",
    },
    {
      path: "subscription wait-get",
      description: "Inspect one wait and its wake delivery",
    },
  ],
} as const;

export const subscriptionWaitGetSpec = {
  path: "subscription wait-get",
  summary: "Inspect one terminal wait and wake batch",
  description:
    "Read the latest wait by subscription id, or select an exact historical generation with --wait-id from subscription waits. Includes reason, expiry, source result, causal history and wake batch. Batch state records queue and runtime acceptance evidence; failed or uncertain delivery needs inspection. This read does not start or acknowledge a turn.",
  requires: "cc",
  effects: "read",
  args: [subscriptionId],
  flags: {
    "wait-id": {
      value: subscriptionId.value,
      description:
        "Exact wait generation id; omit to inspect the latest generation",
    },
  },
  related: [
    { path: "subscription waits", description: "Find wait subscription ids" },
    { path: "inbox get", description: "Inspect the saved source delivery" },
    {
      path: "subscription unfollow",
      description: "Cancel a wait when queue evidence permits it",
    },
  ],
} as const;

export const subscriptionListSpec = {
  path: "subscription list",
  summary: "Inspect this conversation's subscriptions and opt-outs",
  description:
    "List a bounded outline with stable detail handles, source, reason, mode, pause state and delivery problem. Both session and project conversations are supported; an explicit unfollow remains recorded.",
  requires: "cc",
  effects: "read",
  args: [],
  flags: paging,
  related: [
    {
      path: "subscription subscribe",
      description: "Explicitly subscribe to an exact source",
    },
    {
      path: "subscription get",
      description: "Inspect one subscription and its wait evidence",
    },
    {
      path: "subscription waits",
      description: "Inspect active terminal waits",
    },
    {
      path: "subscription unfollow",
      description: "Remember an opt-out for one source",
    },
    {
      path: "inbox list",
      description: "Inspect this conversation's pending updates",
    },
  ],
} as const;

export const subscriptionUnfollowSpec = {
  path: "subscription unfollow",
  summary: "Stop following a source and remember the opt-out",
  description:
    "Unfollow one subscription belonging to the addressed conversation and remember the opt-out. Later reads or involvement do not reactivate it. A finite wait is cancelled when queue evidence permits: pending wakes and unsent planned batches can be withdrawn, while delivering, failed or ambiguous wakes require review. An uncertain batch permits cancellation if the server proves no queue row or accepted transcript receipt exists. Accepted turns cannot be recalled. Existing delivery evidence remains inspectable.",
  requires: "cc",
  effects: "write",
  args: [subscriptionId],
  flags: {},
  related: [
    {
      path: "subscription wait-get",
      description: "Inspect the wake batch before cancelling an active wait",
    },
    {
      path: "subscription list",
      description: "Inspect follows and remembered opt-outs",
    },
  ],
} as const;

export const subscriptionWaitCommand = ccCommands.defineCommand(
  subscriptionWaitSpec,
  {
    examples: [
      {
        args: { kind: "validation", "source-id": "validation-one" },
        flags: {
          reason: "Continue when validation finishes",
          "expires-in": 3600,
        },
        why: "Resume from an exact validation result without blocking this turn",
      },
      {
        args: { kind: "validation", "source-id": "validation-one" },
        flags: { reason: "Inspect the test verdict" },
        why: "Use the default 24 hour lifetime for a validation run",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).subscriptionWaitHandler,
    }),
  },
);
export const subscriptionWaitsCommand = ccCommands.defineCommand(
  subscriptionWaitsSpec,
  {
    examples: [
      {
        flags: { limit: 10 },
        why: "Inspect recent terminal waits and their detail handles",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).subscriptionWaitsHandler,
    }),
  },
);
export const subscriptionWaitGetCommand = ccCommands.defineCommand(
  subscriptionWaitGetSpec,
  {
    examples: [
      {
        args: { "subscription-id": "subscription-one" },
        why: "Distinguish a source result from runtime acceptance of its wake turn",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).subscriptionWaitGetHandler,
    }),
  },
);

export const inboxListSpec = {
  path: "inbox list",
  summary:
    "Inspect pending subscription updates without acknowledging delivery",
  description:
    "Read a bounded inbox page for the addressed session or project conversation. Reconcile durable source changes first. Reads never consume the updates waiting for the next user message. Use --all to include accepted records.",
  requires: "cc",
  effects: "read",
  args: [],
  flags: {
    ...paging,
    all: {
      description: "Include accepted delivery history",
      value: { kind: "boolean" },
    },
  },
  related: [
    {
      path: "inbox get",
      description: "Read one update and its source retrieval command",
    },
    {
      path: "subscription list",
      description: "Inspect why sources are followed",
    },
  ],
} as const;

export const inboxGetSpec = {
  path: "inbox get",
  summary: "Inspect one subscription delivery and its source",
  description:
    "Read the full saved update, source occurrence, acceptance state and retrieval handle by stable delivery id. This inspection neither acknowledges input delivery nor changes human read state.",
  requires: "cc",
  effects: "read",
  args: [
    {
      name: "delivery-id",
      description: "Stable delivery id from inbox list",
      value: { kind: "string", minLength: 1 },
    },
  ],
  flags: {},
  related: [
    {
      path: "inbox list",
      description: "Find pending updates or delivery history",
    },
  ],
} as const;

export const subscriptionListCommand = ccCommands.defineCommand(
  subscriptionListSpec,
  {
    examples: [
      { why: "Inspect the current conversation's follows and opt-outs" },
    ],
    handler: async () => ({
      default: (await import("./handlers")).subscriptionListHandler,
    }),
  },
);
export const subscriptionUnfollowCommand = ccCommands.defineCommand(
  subscriptionUnfollowSpec,
  {
    examples: [
      {
        args: { "subscription-id": "subscription-one" },
        why: "Keep an automatic follow from returning after the next read",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).subscriptionUnfollowHandler,
    }),
  },
);
export const inboxListCommand = ccCommands.defineCommand(inboxListSpec, {
  examples: [
    { why: "Inspect pending context during an ongoing turn" },
    {
      flags: { all: true, limit: 10 },
      why: "Inspect recent delivery evidence including accepted items",
    },
  ],
  handler: async () => ({
    default: (await import("./handlers")).inboxListHandler,
  }),
});
export const inboxGetCommand = ccCommands.defineCommand(inboxGetSpec, {
  examples: [
    {
      args: { "delivery-id": "delivery-one" },
      why: "Inspect the exact source occurrence and delivery state",
    },
  ],
  handler: async () => ({
    default: (await import("./handlers")).inboxGetHandler,
  }),
});
export const subscriptionCommands = [
  ...subscriptionControlCommands,
  subscriptionListCommand,
  subscriptionUnfollowCommand,
  subscriptionWaitCommand,
  subscriptionWaitsCommand,
  subscriptionWaitGetCommand,
  inboxListCommand,
  inboxGetCommand,
];
export const subscriptionGroups = [
  defineGroup({
    path: "subscription",
    summary: "Manage conversation follows and terminal waits",
    description:
      "Follows and explicit terminal waits stay with ordinary conversations across runtime replacement. Workflow lanes retain their assigned context policy.",
    related: [{ path: "inbox", description: "Inspect the resulting updates" }],
  }),
  defineGroup({
    path: "inbox",
    summary: "Inspect subscription updates and delivery evidence",
    description:
      "Explicit reads are available at any time and do not acknowledge passive delivery.",
    related: [
      { path: "subscription", description: "Inspect follows and opt-outs" },
    ],
  }),
];
