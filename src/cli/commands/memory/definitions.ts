import { bytes, defineGroup } from "cli-for-agents";
import { ccCommands } from "../../framework/family";

const read = { requires: "cc", effects: "read" } as const;
const write = { requires: "cc", effects: "write" } as const;
const slug = {
  name: "slug",
  description: "Memory slug or previously returned handle",
  value: { kind: "string", minLength: 1 },
} as const;
const scope = {
  description: "Narrow a handle to one visible scope",
  value: { kind: "enum", values: ["global", "project", "session"] },
} as const;
const kind = {
  description: "Kind of durable knowledge",
  value: {
    kind: "enum",
    values: ["lesson", "procedure", "preference", "state"],
  },
} as const;
const indexMode = {
  description:
    "auto competes, always reserves a slot, search-only never competes; always is for a trap that bites regardless of the task, search-only for reference material",
  value: { kind: "enum", values: ["auto", "always", "search-only"] },
} as const;
const hook = {
  description:
    "the hook is the whole index entry; state a durable fact that stands alone",
  value: { kind: "string", minLength: 1 },
  fileSource: { maxBytes: bytes(262_144) },
} as const;
const body = {
  description: "Put the mechanism or the exact command in the Markdown body",
  value: { kind: "string" },
  fileSource: { maxBytes: bytes(262_144) },
} as const;
const statusNote = {
  description:
    "A perishable caveat goes in the statusNote, never in the hook; none clears it",
  value: { kind: "string" },
  fileSource: { maxBytes: bytes(262_144) },
} as const;
const revision = {
  description: "Revision this write is based on",
  value: { kind: "integer", min: 1 },
} as const;
const limit = {
  description: "Maximum rows returned",
  value: { kind: "integer", min: 1 },
  default: 20,
} as const;
const artifact = {
  description: "Native artifact handle, such as ticket:42 or execution:run-id",
  value: { kind: "string", minLength: 1 },
} as const;
const linkKind = {
  description: "Relevance or provenance link",
  value: { kind: "enum", values: ["about", "source"] },
  default: "about",
} as const;
const editFlags = {
  hook,
  body,
  "status-note": statusNote,
  "index-mode": indexMode,
  slug: {
    description: "Canonical slug",
    value: { kind: "string", minLength: 1 },
  },
  alias: {
    description: "Additional name; repeat for multiple aliases",
    value: { kind: "string", minLength: 1 },
    repeatable: true,
  },
  "review-after": {
    description: "Review lease timestamp, or none",
    value: { kind: "string", minLength: 1 },
  },
  "expires-at": {
    description: "Expiry timestamp, or none",
    value: { kind: "string", minLength: 1 },
  },
} as const;

export const memorySpecs = {
  recall: {
    ...read,
    path: "memory recall",
    summary: "Retrieve a bounded memory pack",
    description:
      "Search by query or linked artifact, or read ambient memory. The server owns ranking, budget, visibility, and narrowing guidance. The index omits hooks, so recall before you conclude. Open a body for the mechanism or the exact command.",
    args: [
      {
        name: "query",
        description: "Search query",
        value: { kind: "string" },
        required: false,
      },
    ],
    flags: {
      related: artifact,
      scope,
      budget: {
        description: "Pack character budget",
        value: { kind: "integer", min: 1 },
      },
    },
  },
  index: {
    ...read,
    path: "memory index",
    summary: "Read the memory index due for a conversation",
    description:
      "Preview the server-composed next-turn block without settling or resetting delivery state. The delta carries only what changed since your last turn; full requests the whole visible index. The exact block remains available in structured data, with native-memory disclosure alongside it. The block omits hooks, so recall before you conclude. Dispatch-only model, output-schema, or lane write-envelope changes can rebuild the runtime and cause a full delivery that this preview cannot predict; use full to inspect that block. Target one conversation, not a project or session.",
    args: [],
    flags: {
      full: {
        description: "Return the full visible index",
        value: { kind: "boolean" },
      },
    },
  },
  list: {
    ...read,
    path: "memory list",
    summary: "List visible memory notes",
    description:
      "List notes by canonical slug, with an explicit continuation for omitted rows.",
    args: [],
    flags: {
      scope,
      lifecycle: {
        description: "Filter lifecycle",
        value: { kind: "enum", values: ["proposed", "active", "archived"] },
      },
      archived: {
        description: "Include archived notes",
        value: { kind: "boolean" },
      },
      limit,
    },
  },
  get: {
    ...read,
    path: "memory get",
    summary: "Read a note, links, and lineage",
    description:
      "Read a canonical memory note by slug or handle. Scope narrows ambiguity without widening server visibility.",
    args: [slug],
    flags: {
      scope,
      archived: {
        description: "Include archived notes",
        value: { kind: "boolean" },
      },
    },
  },
  create: {
    ...write,
    path: "memory create",
    summary: "Capture durable knowledge",
    description:
      "Create a note attributed to the current conversation. Global notes remain proposals until a human approves them in the Memory Library. Link the note to the ticket, spec, or workflow it is about.",
    args: [],
    flags: {
      ...editFlags,
      hook: { ...hook, required: true },
      scope,
      kind,
      supersedes: {
        description: "Predecessor note this replaces",
        value: { kind: "string", minLength: 1 },
      },
    },
  },
  update: {
    ...write,
    path: "memory update",
    summary: "Update a note at its observed revision",
    description:
      "Update only supplied fields, preserving compare-and-swap and server scope policy.",
    args: [slug],
    flags: {
      ...editFlags,
      scope,
      "if-revision": { ...revision, required: true },
    },
  },
  link: {
    ...write,
    path: "memory link",
    summary: "Link a note to a native artifact",
    description:
      "Link knowledge to the ticket, spec, or workflow it is about. Bind relevance or provenance to a ticket, spec, execution, context, or session incarnation. The server resolves artifact identity.",
    args: [slug],
    flags: { scope, kind: linkKind, artifact: { ...artifact, required: true } },
  },
  unlink: {
    ...write,
    path: "memory unlink",
    summary: "Remove a native artifact link",
    description:
      "Remove the exact artifact link without changing the note's content.",
    args: [slug],
    flags: { scope, kind: linkKind, artifact: { ...artifact, required: true } },
  },
  markReviewed: {
    ...write,
    path: "memory mark-reviewed",
    summary: "Reaffirm a note or its leased status",
    description:
      "Mark a note reviewed, or explicitly re-lease its perishable status with status. The response prints the status line you are re-asserting, its age, and its new lease. Eligible is not delivered: scope, index mode, and budget decide whether the line travels with its note. A perishable caveat goes in the statusNote, never in the hook; update it when the claim has changed.",
    args: [slug],
    flags: {
      scope,
      "if-revision": revision,
      status: {
        description: "Reaffirm the status note instead of the durable note",
        value: { kind: "boolean" },
      },
    },
  },
  observeRederivation: {
    ...read,
    path: "memory observe-rederivation",
    summary: "Record a round that re-derived known knowledge",
    description:
      "Record telemetry without changing note content, revision, or contribution policy. The response names identities without exposing retrieval counts.",
    args: [slug],
    flags: { scope, artifact },
  },
  promote: {
    ...write,
    path: "memory promote",
    summary: "Promote session knowledge into the project",
    description:
      "Promote a completed-session lesson and preserve its supersession lineage.",
    args: [slug],
    flags: {
      slug: editFlags.slug,
      hook,
      body,
      "status-note": statusNote,
      "index-mode": indexMode,
      "if-revision": revision,
    },
  },
  review: {
    ...read,
    path: "memory review",
    summary: "Read stale notes and promotion candidates",
    description:
      "Read why each note is queued for review or promotion, bounded with an exact continuation.",
    args: [],
    flags: {
      limit,
      "project-candidates": {
        description: "Include completed-session candidates from this project",
        value: { kind: "boolean" },
      },
      promotable: {
        description: "Narrow to promotion candidates",
        value: { kind: "boolean" },
      },
    },
  },
  archive: {
    ...write,
    path: "memory archive",
    summary: "Archive a note while retaining history",
    description:
      "Archive a visible note under the existing server policy. Archived reads remain available explicitly.",
    args: [slug],
    flags: { scope, "if-revision": revision },
  },
  delete: {
    ...write,
    path: "memory delete",
    summary: "Permanently delete a note and its history",
    description:
      "Permanently delete a note only with explicit confirmation. Archive retains history and is available separately.",
    args: [slug],
    flags: {
      scope,
      confirm: {
        description: "Confirm permanent destruction",
        value: { kind: "boolean" },
      },
    },
  },
  export: {
    ...read,
    path: "memory export",
    summary: "Export a portable memory archive",
    description:
      "Write the exact frontmatter-Markdown archive through the artifact boundary. Revision history remains in the database. Use out to select its destination.",
    output: "binary",
    args: [],
    flags: { scope },
  },
} as const;

export const memoryRecallCommand = ccCommands.defineCommand(
  memorySpecs.recall,
  {
    examples: [
      {
        args: { query: "shell quoting" },
        why: "Find knowledge relevant to this task",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).recallHandler,
    }),
  },
);
export const memoryIndexCommand = ccCommands.defineCommand(memorySpecs.index, {
  examples: [
    { flags: { full: true }, why: "Inspect the complete visible index" },
  ],
  handler: async () => ({ default: (await import("./handlers")).indexHandler }),
});
export const memoryListCommand = ccCommands.defineCommand(memorySpecs.list, {
  examples: [{ flags: { scope: "project" }, why: "List project notes" }],
  handler: async () => ({ default: (await import("./handlers")).listHandler }),
});
export const memoryGetCommand = ccCommands.defineCommand(memorySpecs.get, {
  examples: [
    { args: { slug: "literal-shell-prose" }, why: "Read a note in full" },
  ],
  handler: async () => ({ default: (await import("./handlers")).getHandler }),
});
export const memoryCreateCommand = ccCommands.defineCommand(
  memorySpecs.create,
  {
    examples: [
      {
        flags: { hook: "Pass literal prose through a file" },
        why: "Capture a durable lesson",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).createHandler,
    }),
  },
);
export const memoryUpdateCommand = ccCommands.defineCommand(
  memorySpecs.update,
  {
    examples: [
      {
        args: { slug: "literal-shell-prose" },
        flags: { "if-revision": 3, "body-file": ".cc/temp/memory.md" },
        why: "Update the note at its current revision",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).updateHandler,
    }),
  },
);
export const memoryLinkCommand = ccCommands.defineCommand(memorySpecs.link, {
  examples: [
    {
      args: { slug: "literal-shell-prose" },
      flags: { artifact: "ticket:42" },
      why: "Associate a lesson with its ticket",
    },
  ],
  handler: async () => ({ default: (await import("./handlers")).linkHandler }),
});
export const memoryUnlinkCommand = ccCommands.defineCommand(
  memorySpecs.unlink,
  {
    examples: [
      {
        args: { slug: "literal-shell-prose" },
        flags: { artifact: "ticket:42" },
        why: "Remove an obsolete association",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).unlinkHandler,
    }),
  },
);
export const memoryMarkReviewedCommand = ccCommands.defineCommand(
  memorySpecs.markReviewed,
  {
    examples: [
      {
        args: { slug: "literal-shell-prose" },
        why: "Reaffirm current knowledge",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).markReviewedHandler,
    }),
  },
);
export const memoryObserveRederivationCommand = ccCommands.defineCommand(
  memorySpecs.observeRederivation,
  {
    examples: [
      {
        args: { slug: "literal-shell-prose" },
        flags: { artifact: "execution:run-one" },
        why: "Record duplicated reasoning in a validation round",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).observeRederivationHandler,
    }),
  },
);
export const memoryPromoteCommand = ccCommands.defineCommand(
  memorySpecs.promote,
  {
    examples: [
      {
        args: { slug: "session-lesson" },
        why: "Retain completed-session knowledge for the project",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).promoteHandler,
    }),
  },
);
export const memoryReviewCommand = ccCommands.defineCommand(
  memorySpecs.review,
  {
    examples: [
      {
        flags: { "project-candidates": true },
        why: "Inspect stale knowledge and promotion candidates",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).reviewHandler,
    }),
  },
);
export const memoryArchiveCommand = ccCommands.defineCommand(
  memorySpecs.archive,
  {
    examples: [
      {
        args: { slug: "literal-shell-prose" },
        why: "Retire a note while preserving history",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).archiveHandler,
    }),
  },
);
export const memoryDeleteCommand = ccCommands.defineCommand(
  memorySpecs.delete,
  {
    examples: [
      {
        args: { slug: "literal-shell-prose" },
        flags: { confirm: true },
        why: "Permanently delete a deliberately retired note",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).deleteHandler,
    }),
  },
);
export const memoryExportCommand = ccCommands.defineCommand(
  memorySpecs.export,
  {
    examples: [
      {
        flags: { scope: "project" },
        out: ".cc/temp/memory.md",
        why: "Export a portable project memory archive",
      },
    ],
    handler: async () => ({
      default: (await import("./handlers")).exportHandler,
    }),
  },
);
export const memoryCommands = [
  memoryRecallCommand,
  memoryIndexCommand,
  memoryListCommand,
  memoryGetCommand,
  memoryCreateCommand,
  memoryUpdateCommand,
  memoryLinkCommand,
  memoryUnlinkCommand,
  memoryMarkReviewedCommand,
  memoryObserveRederivationCommand,
  memoryPromoteCommand,
  memoryReviewCommand,
  memoryArchiveCommand,
  memoryDeleteCommand,
  memoryExportCommand,
] as const;
export const memoryGroups = [
  defineGroup({
    path: "memory",
    summary: "Recall and maintain shared memory",
    description: [
      "Memory is shared across agent backends. The server derives visibility and write authority from the current conversation. Human approval and revision restoration remain in the Memory Library.",
      hook.description,
      body.description,
      indexMode.description,
      statusNote.description,
      "Link a note to the ticket, spec, or workflow it is about. The index is budgeted and omits hooks, so recall before you conclude.",
    ].join(" "),
  }),
] as const;
