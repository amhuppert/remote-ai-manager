import { bytes, defineGroup } from "cli-for-agents";
import { ccCommands } from "../../framework/family";

const notepadId = {
  name: "notepad-id",
  description: "Immutable notepad id from a list row or reference",
  value: { kind: "string", minLength: 1 },
} as const;
const content = {
  description: "Canonical Markdown, including reference XML and image tokens",
  value: { kind: "string" },
  fileSource: { maxBytes: bytes(262_144) },
} as const;
const globalScope = {
  description: "Use global scope instead of the ambient project",
  value: { kind: "boolean" },
} as const;
const limit = {
  description: "Maximum rows to return",
  value: { kind: "integer", min: 1 },
  default: 20,
} as const;
const baseRevision = {
  description: "Revision from the read this write is based on",
  value: { kind: "integer", min: 1 },
  required: true,
} as const;

export const notepadListSpec = {
  path: "notepad list",
  summary: "List notepads with ids and revisions",
  description:
    "List global notepads merged with the ambient project's. Archived notepads are hidden unless requested. Omitted rows name an exact follow-up read.",
  requires: "cc",
  effects: "read",
  args: [],
  flags: {
    global: globalScope,
    archived: {
      description: "Include archived notepads",
      value: { kind: "boolean" },
    },
    limit,
  },
  related: [
    { path: "notepad get", description: "Read one notepad" },
    { path: "notepad create", description: "Create a notepad" },
  ],
} as const;
export const notepadGetSpec = {
  path: "notepad get",
  summary: "Read a notepad's canonical content",
  description:
    "Read by immutable id, including its revision and write mode. Full Markdown and embedded references remain intact; large results become artifacts.",
  requires: "cc",
  effects: "read",
  args: [notepadId],
  flags: {},
  related: [
    { path: "notepad list", description: "Find notepad ids" },
    {
      path: "notepad update",
      description: "Replace content at the revision read",
    },
    { path: "notepad append", description: "Append at the revision read" },
    { path: "notepad comment list", description: "Read review comments" },
  ],
} as const;
export const notepadCreateSpec = {
  path: "notepad create",
  summary: "Create a project or global notepad",
  description:
    "Create a notepad attributed to the current conversation. Names are unique within a scope; the server decides write policy.",
  requires: "cc",
  effects: "write",
  args: [],
  flags: {
    name: {
      description: "Display name unique within this scope",
      value: { kind: "string", minLength: 1 },
      required: true,
    },
    global: globalScope,
    content,
  },
  related: [
    { path: "notepad list", description: "List notepads" },
    { path: "notepad get", description: "Read the created notepad" },
  ],
} as const;
export const notepadUpdateSpec = {
  path: "notepad update",
  summary: "Replace content at the revision you read",
  description:
    "Replace the notepad content if its revision still matches. The server enforces the user's write mode and refuses stale writes.",
  requires: "cc",
  effects: "write",
  args: [notepadId],
  flags: {
    "if-revision": baseRevision,
    content: { ...content, required: true },
  },
  related: [
    { path: "notepad get", description: "Read the current revision" },
    {
      path: "notepad append",
      description: "Append instead of replacing content",
    },
  ],
} as const;
export const notepadAppendSpec = {
  path: "notepad append",
  summary: "Append content at the revision you read",
  description:
    "Append Markdown if the notepad revision still matches. The server enforces the user's write mode and refuses stale writes.",
  requires: "cc",
  effects: "write",
  args: [notepadId],
  flags: {
    "if-revision": baseRevision,
    content: { ...content, required: true },
  },
  related: [
    { path: "notepad get", description: "Read the current revision" },
    { path: "notepad update", description: "Replace content" },
  ],
} as const;
export const notepadCommentListSpec = {
  path: "notepad comment list",
  summary: "Read comments, quoted passages, and replies",
  description:
    "Read review threads with their current anchor state. Stale quotes remain visible and are never silently relocated. Omitted threads name an exact follow-up read.",
  requires: "cc",
  effects: "read",
  args: [notepadId],
  flags: {
    status: {
      description: "Narrow to one comment status",
      value: { kind: "enum", values: ["open", "resolved"] },
    },
    limit,
  },
  related: [
    { path: "notepad get", description: "Read the quoted passage in context" },
    { path: "notepad comment reply", description: "Answer a comment" },
  ],
} as const;
export const notepadCommentReplySpec = {
  path: "notepad comment reply",
  summary: "Reply to one notepad comment",
  description:
    "Add a reply attributed to the current conversation. Replies do not change notepad content or settle comments; the user decides whether a comment is resolved.",
  requires: "cc",
  effects: "write",
  args: [
    notepadId,
    {
      name: "comment-id",
      description: "Comment id from the thread listing",
      value: { kind: "string", minLength: 1 },
    },
  ],
  flags: {
    body: {
      description: "Markdown reply addressing the comment",
      value: { kind: "string", minLength: 1 },
      required: true,
      fileSource: { maxBytes: bytes(262_144) },
    },
  },
  related: [
    { path: "notepad comment list", description: "Find comments to answer" },
    {
      path: "notepad update",
      description: "Change content discussed in a comment",
    },
  ],
} as const;

export const notepadListCommand = ccCommands.defineCommand(notepadListSpec, {
  examples: [
    { why: "List current project and global notepads" },
    {
      flags: { global: true, archived: true },
      why: "Include archived global notepads",
    },
  ],
  handler: async () => ({ default: (await import("./handlers")).listHandler }),
});
export const notepadGetCommand = ccCommands.defineCommand(notepadGetSpec, {
  examples: [
    {
      args: { "notepad-id": "notepad-one" },
      why: "Read the current canonical content and revision",
    },
  ],
  handler: async () => ({ default: (await import("./handlers")).getHandler }),
});
export const notepadCreateCommand = ccCommands.defineCommand(
  notepadCreateSpec,
  {
    examples: [
      {
        flags: { name: "Migration notes", content: "## Checklist" },
        why: "Create a project notepad",
      },
      {
        flags: {
          name: "Standing context",
          global: true,
          "content-file": ".cc/temp/notepad.md",
        },
        why: "Create a global notepad from a Markdown file",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).createHandler,
    }),
  },
);
export const notepadUpdateCommand = ccCommands.defineCommand(
  notepadUpdateSpec,
  {
    examples: [
      {
        args: { "notepad-id": "notepad-one" },
        flags: { "if-revision": 4, "content-file": ".cc/temp/notepad.md" },
        why: "Replace content only if revision 4 remains current",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).updateHandler,
    }),
  },
);
export const notepadAppendCommand = ccCommands.defineCommand(
  notepadAppendSpec,
  {
    examples: [
      {
        args: { "notepad-id": "notepad-one" },
        flags: { "if-revision": 4, content: "## Follow-up" },
        why: "Append content at the revision read",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).appendHandler,
    }),
  },
);
export const notepadCommentListCommand = ccCommands.defineCommand(
  notepadCommentListSpec,
  {
    examples: [
      {
        args: { "notepad-id": "notepad-one" },
        flags: { status: "open" },
        why: "Read comments still awaiting the user's disposition",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).commentListHandler,
    }),
  },
);
export const notepadCommentReplyCommand = ccCommands.defineCommand(
  notepadCommentReplySpec,
  {
    examples: [
      {
        args: { "notepad-id": "notepad-one", "comment-id": "comment-one" },
        flags: { "body-file": ".cc/temp/reply.md" },
        why: "Answer a comment without changing its status",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).commentReplyHandler,
    }),
  },
);
export const notepadCommands = [
  notepadListCommand,
  notepadGetCommand,
  notepadCreateCommand,
  notepadUpdateCommand,
  notepadAppendCommand,
  notepadCommentListCommand,
  notepadCommentReplyCommand,
] as const;
export const notepadGroups = [
  defineGroup({
    path: "notepad",
    summary: "Read and write shared notepads",
    description:
      "Notepads are addressed by immutable ids. Rename, write-mode changes, pin, archive, and delete are user actions in the notepad panel.",
  }),
  defineGroup({
    path: "notepad comment",
    summary: "Read and answer review comments",
    description:
      "Read anchored review threads and add replies. Resolving, reopening, and deleting comments are user actions.",
  }),
] as const;
