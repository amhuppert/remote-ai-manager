import { defineGroup } from "cli-for-agents";
import { ccCommands } from "../../framework/family";

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

export const subscriptionListSpec = {
  path: "subscription list",
  summary: "Inspect this conversation's automatic follows and opt-outs",
  description:
    "List bounded subscription records with their source, reason, cursor and delivery problem. Both session and project conversations are supported; an explicit unfollow remains recorded.",
  requires: "cc",
  effects: "read",
  args: [],
  flags: paging,
  related: [
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
    "Unfollow one subscription belonging to the addressed conversation. Later reads or involvement do not reactivate it. Existing delivery evidence remains inspectable.",
  requires: "cc",
  effects: "write",
  args: [
    {
      name: "subscription-id",
      description: "Stable id from subscription list",
      value: {
        kind: "pattern",
        pattern: "^\\S+$",
        description: "non-whitespace subscription id",
      },
    },
  ],
  flags: {},
  related: [
    {
      path: "subscription list",
      description: "Inspect follows and remembered opt-outs",
    },
  ],
} as const;

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
  subscriptionListCommand,
  subscriptionUnfollowCommand,
  inboxListCommand,
  inboxGetCommand,
];
export const subscriptionGroups = [
  defineGroup({
    path: "subscription",
    summary: "Inspect automatic conversation follows and remember opt-outs",
    description:
      "Passive follows stay with the conversation across runtime replacement. Workflow lanes and active wake controls are outside this surface.",
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
