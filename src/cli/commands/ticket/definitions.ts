import { bytes, defineGroup } from "cli-for-agents";
import { ccCommands } from "../../framework/family";
const read = { requires: "cc", effects: "read" } as const;
const write = { requires: "cc", effects: "write" } as const;
const ticket = {
  name: "ticket",
  description: "Bare ticket number or qualified project#number",
  value: { kind: "string", minLength: 1 },
} as const;
const description = {
  description: "Markdown description",
  value: { kind: "string" },
  fileSource: { maxBytes: bytes(262_144) },
} as const;
const status = {
  description: "Ticket lifecycle status",
  value: {
    kind: "enum",
    values: ["not_started", "in_progress", "done", "blocked", "closed"],
  },
} as const;
const workType = {
  description: "Kind of work",
  value: {
    kind: "enum",
    values: ["feature", "bug", "research", "tech_debt", "performance"],
  },
} as const;
const title = {
  description: "Ticket title",
  value: { kind: "string", minLength: 1 },
} as const;
const role = {
  description: "Relationship as seen from this ticket",
  value: {
    kind: "enum",
    values: ["related", "depends_on", "blocks", "parent", "child"],
  },
} as const;
const relationId = {
  name: "relationship-id",
  description: "Returned relationship id",
  value: { kind: "string", minLength: 1 },
} as const;
const updateId = {
  name: "update-id",
  description: "Returned status update id",
  value: { kind: "string", minLength: 1 },
} as const;
const attachmentId = {
  name: "attachment-id",
  description: "Returned attachment id",
  value: { kind: "string", minLength: 1 },
} as const;
const pages = {
  limit: {
    description: "Page size",
    value: { kind: "integer", min: 1, max: 100 },
    default: 20,
  },
  cursor: {
    description: "Opaque cursor returned by the preceding page",
    value: { kind: "string", minLength: 1 },
  },
} as const;
const markdown = {
  description: "Full Markdown note",
  value: { kind: "string" },
  fileSource: { maxBytes: bytes(262_144) },
} as const;
const prepared = {
  description: "Server transfer id from an earlier preparation",
  value: { kind: "string", minLength: 1 },
} as const;
export const ticketSpecs = {
  create: {
    ...write,
    path: "ticket create",
    summary: "Create a ticket",
    description:
      "Create a project ticket with its required title and work type. Markdown descriptions accept literal file input.",
    args: [],
    flags: {
      title: { ...title, required: true },
      type: { ...workType, required: true },
      description,
      status,
    },
  },
  list: {
    ...read,
    path: "ticket list",
    summary: "List tickets",
    description:
      "List a bounded set, optionally across projects or with bounded attachment indexes. Continuations retain every filter.",
    args: [],
    flags: {
      status,
      type: workType,
      sort: {
        description: "Sort timestamp",
        value: { kind: "enum", values: ["created", "updated"] },
      },
      all: { description: "List all projects", value: { kind: "boolean" } },
      attachments: {
        description: "Include bounded attachment indexes",
        value: { kind: "boolean" },
      },
      limit: {
        description: "Maximum rows",
        value: { kind: "integer", min: 1 },
        default: 20,
      },
    },
  },
  get: {
    ...read,
    path: "ticket get",
    summary: "Read a ticket and its context outlines",
    description:
      "Read full ticket prose and bounded relationship/status outlines. Each omitted resource has its own read command.",
    args: [ticket],
    flags: {},
  },
  update: {
    ...write,
    path: "ticket update",
    summary: "Update ticket fields",
    description:
      "Update only supplied fields; the server validates lifecycle and work type.",
    args: [ticket],
    flags: { title, description, type: workType, status },
  },
  delete: {
    ...write,
    path: "ticket delete",
    summary: "Delete a ticket",
    description: "Delete the addressed ticket through the domain service.",
    args: [ticket],
    flags: {},
  },
  start: {
    ...write,
    path: "ticket start",
    summary: "Start a ticket work session",
    description:
      "Prepared mode waits for a prompt; agent mode queues the kickoff. Conversation snapshot capture continues in the background and remains visible in the receipt.",
    args: [ticket],
    flags: {
      mode: {
        description: "Session kickoff mode",
        value: { kind: "enum", values: ["agent", "prepared"] },
        required: true,
      },
      backend: {
        description: "Agent backend",
        value: { kind: "enum", values: ["claude", "codex"] },
      },
      model: {
        description: "Model id",
        value: { kind: "string", minLength: 1 },
      },
      "model-param": {
        description: "Model parameter id=value; repeat for distinct parameters",
        value: { kind: "string", minLength: 1 },
        repeatable: true,
      },
    },
  },
  relationList: {
    ...read,
    path: "ticket relation list",
    summary: "List ticket relationships",
    description:
      "Read a bounded page with role-preserving cursor continuation and stable full-read handles.",
    args: [ticket],
    flags: { ...pages, role },
  },
  relationGet: {
    ...read,
    path: "ticket relation get",
    summary: "Read a relationship in full",
    description:
      "Read the full relationship rationale from this ticket's perspective.",
    args: [ticket, relationId],
    flags: {},
  },
  relationAdd: {
    ...write,
    path: "ticket relation add",
    summary: "Add a relationship",
    description:
      "Link two independently resolved ticket references. The server owns graph direction, cycle checks, and project constraints.",
    args: [ticket, { ...ticket, name: "other" }],
    flags: { role: { ...role, required: true }, description },
  },
  relationUpdate: {
    ...write,
    path: "ticket relation update",
    summary: "Update relationship rationale",
    description:
      "Replace the relationship description without changing graph direction.",
    args: [ticket, relationId],
    flags: { description: { ...description, required: true } },
  },
  relationRemove: {
    ...write,
    path: "ticket relation remove",
    summary: "Remove a relationship",
    description:
      "Remove the addressed relationship through the domain service.",
    args: [ticket, relationId],
    flags: {},
  },
  statusAdd: {
    ...write,
    path: "ticket status-update add",
    summary: "Append a status update",
    description:
      "Append immutable progress prose. Agent provenance comes exclusively from CC_CONVERSATION_ID; conversation overrides are rejected.",
    args: [ticket],
    flags: { body: { ...markdown, required: true } },
  },
  statusList: {
    ...read,
    path: "ticket status-update list",
    summary: "List status updates",
    description:
      "Read a bounded chronological page with stable full-read handles and an exact cursor continuation.",
    args: [ticket],
    flags: pages,
  },
  statusGet: {
    ...read,
    path: "ticket status-update get",
    summary: "Read a status update in full",
    description: "Read full Markdown and durable author provenance.",
    args: [ticket, updateId],
    flags: {},
  },
  attachFile: {
    ...write,
    path: "ticket attach file",
    summary: "Attach original file bytes",
    description:
      "Upload a bounded binary file with a description explaining its relevance.",
    args: [
      ticket,
      {
        name: "path",
        description: "Local source file",
        value: { kind: "string", minLength: 1 },
      },
    ],
    flags: {
      description: { ...description, required: true },
      "media-type": {
        description: "File media type",
        value: { kind: "string", minLength: 1 },
      },
    },
  },
  attachConversation: {
    ...write,
    path: "ticket attach conversation",
    summary: "Attach a conversation snapshot",
    description:
      "Capture a conversation from the ambient project. Explicit conversation ids use only an explicit session; the current conversation retains its ambient session.",
    args: [
      ticket,
      {
        name: "conversation-id",
        description: "Conversation to capture; defaults to the current one",
        value: { kind: "string", minLength: 1 },
        required: false,
      },
    ],
    flags: { description: { ...description, required: true } },
  },
  attachSession: {
    ...write,
    path: "ticket attach session",
    summary: "Attach session context",
    description:
      "Attach a session from the ambient project, independently of the host ticket's project.",
    args: [
      ticket,
      {
        name: "session-name",
        description: "Source session",
        value: { kind: "string", minLength: 1 },
      },
    ],
    flags: { description: { ...description, required: true } },
  },
  attachNote: {
    ...write,
    path: "ticket attach note",
    summary: "Attach Markdown context",
    description:
      "Supply the note once, as positional Markdown or the markdown flag/file alternative.",
    args: [
      ticket,
      {
        name: "markdown",
        description: "Full note prose",
        value: { kind: "string" },
        required: false,
      },
    ],
    flags: { description: { ...description, required: true }, markdown },
  },
  attachmentGet: {
    ...read,
    path: "ticket attachment get",
    summary: "Resolve an attachment",
    description:
      "Resolve full note, session, conversation, or file context. Binary files are decoded into exact artifact bytes; pending and failed snapshots retain server-owned retry information.",
    output: "binary",
    args: [ticket, attachmentId],
    flags: {},
  },
  attachmentUpdate: {
    ...write,
    path: "ticket attachment update",
    summary: "Update attachment metadata or note prose",
    description:
      "Update supplied fields only; snapshot content remains owned by its source.",
    args: [ticket, attachmentId],
    flags: { description, markdown },
  },
  attachmentRefresh: {
    ...write,
    path: "ticket attachment refresh",
    summary: "Refresh a conversation snapshot",
    description:
      "Schedule snapshot refresh and report pending or failed capture state without blocking.",
    args: [ticket, attachmentId],
    flags: {},
  },
  attachmentRemove: {
    ...write,
    path: "ticket attachment remove",
    summary: "Remove an attachment",
    description:
      "Remove the addressed attachment and retain the server's deletion receipt.",
    args: [ticket, attachmentId],
    flags: {},
  },
  export: {
    ...write,
    path: "ticket export",
    summary: "Prepare and export a ticket bundle",
    description:
      "Prepare a server transfer, wait for its result, and write the exact gzip archive through artifact delivery. Omitted sources require acknowledgment of the reviewed prepared digest.",
    output: "binary",
    args: [ticket],
    flags: {
      prepared,
      acknowledge: {
        description: "Digest of a reviewed prepared archive with omissions",
        value: { kind: "string", minLength: 1 },
      },
    },
  },
  import: {
    ...write,
    path: "ticket import",
    summary: "Import a ticket bundle",
    description:
      "Upload an archive or resume a prepared transfer. Duplicate import requires its explicit flag; the server owns digest verification and completion.",
    args: [],
    flags: {
      archive: {
        description: "Local gzip archive (binary input)",
        value: { kind: "string", minLength: 1 },
      },
      prepared,
      "allow-duplicate": {
        description: "Explicitly import a previously imported archive again",
        value: { kind: "boolean" },
      },
    },
  },
} as const;
export const createCommand = ccCommands.defineCommand(ticketSpecs.create, {
  examples: [
    {
      ...{ flags: { title: "Fix gate", type: "bug" } },
      why: "create ticket context",
    },
  ],
  handler: async () => ({
    default: (await import("./crud.handler")).createHandler,
  }),
});
export const listCommand = ccCommands.defineCommand(ticketSpecs.list, {
  examples: [{ ...{}, why: "list ticket context" }],
  handler: async () => ({
    default: (await import("./crud.handler")).listHandler,
  }),
});
export const getCommand = ccCommands.defineCommand(ticketSpecs.get, {
  examples: [{ ...{ args: { ticket: "cc#12" } }, why: "get ticket context" }],
  handler: async () => ({
    default: (await import("./crud.handler")).getHandler,
  }),
});
export const updateCommand = ccCommands.defineCommand(ticketSpecs.update, {
  examples: [
    {
      ...{ args: { ticket: "cc#12" }, flags: { status: "done" } },
      why: "update ticket context",
    },
  ],
  handler: async () => ({
    default: (await import("./crud.handler")).updateHandler,
  }),
});
export const deleteCommand = ccCommands.defineCommand(ticketSpecs.delete, {
  examples: [
    { ...{ args: { ticket: "cc#12" } }, why: "delete ticket context" },
  ],
  handler: async () => ({
    default: (await import("./crud.handler")).deleteHandler,
  }),
});
export const startCommand = ccCommands.defineCommand(ticketSpecs.start, {
  examples: [
    {
      ...{ args: { ticket: "cc#12" }, flags: { mode: "prepared" } },
      why: "start ticket context",
    },
  ],
  handler: async () => ({
    default: (await import("./crud.handler")).startHandler,
  }),
});
export const relationListCommand = ccCommands.defineCommand(
  ticketSpecs.relationList,
  {
    examples: [
      { ...{ args: { ticket: "cc#12" } }, why: "relationList ticket context" },
    ],
    handler: async () => ({
      default: (await import("./relations.handler")).relationListHandler,
    }),
  },
);
export const relationGetCommand = ccCommands.defineCommand(
  ticketSpecs.relationGet,
  {
    examples: [
      {
        ...{ args: { ticket: "cc#12", "relationship-id": "rel-one" } },
        why: "relationGet ticket context",
      },
    ],
    handler: async () => ({
      default: (await import("./relations.handler")).relationGetHandler,
    }),
  },
);
export const relationAddCommand = ccCommands.defineCommand(
  ticketSpecs.relationAdd,
  {
    examples: [
      {
        ...{
          args: { ticket: "cc#12", other: "cc#7" },
          flags: { role: "depends_on" },
        },
        why: "relationAdd ticket context",
      },
    ],
    handler: async () => ({
      default: (await import("./relations.handler")).relationAddHandler,
    }),
  },
);
export const relationUpdateCommand = ccCommands.defineCommand(
  ticketSpecs.relationUpdate,
  {
    examples: [
      {
        ...{
          args: { ticket: "cc#12", "relationship-id": "rel-one" },
          flags: { description: "Shared API prerequisite" },
        },
        why: "relationUpdate ticket context",
      },
    ],
    handler: async () => ({
      default: (await import("./relations.handler")).relationUpdateHandler,
    }),
  },
);
export const relationRemoveCommand = ccCommands.defineCommand(
  ticketSpecs.relationRemove,
  {
    examples: [
      {
        ...{ args: { ticket: "cc#12", "relationship-id": "rel-one" } },
        why: "relationRemove ticket context",
      },
    ],
    handler: async () => ({
      default: (await import("./relations.handler")).relationRemoveHandler,
    }),
  },
);
export const statusAddCommand = ccCommands.defineCommand(
  ticketSpecs.statusAdd,
  {
    examples: [
      {
        ...{
          args: { ticket: "cc#12" },
          flags: { body: "First slice implemented." },
        },
        why: "statusAdd ticket context",
      },
    ],
    handler: async () => ({
      default: (await import("./relations.handler")).statusAddHandler,
    }),
  },
);
export const statusListCommand = ccCommands.defineCommand(
  ticketSpecs.statusList,
  {
    examples: [
      { ...{ args: { ticket: "cc#12" } }, why: "statusList ticket context" },
    ],
    handler: async () => ({
      default: (await import("./relations.handler")).statusListHandler,
    }),
  },
);
export const statusGetCommand = ccCommands.defineCommand(
  ticketSpecs.statusGet,
  {
    examples: [
      {
        ...{ args: { ticket: "cc#12", "update-id": "update-one" } },
        why: "statusGet ticket context",
      },
    ],
    handler: async () => ({
      default: (await import("./relations.handler")).statusGetHandler,
    }),
  },
);
export const attachFileCommand = ccCommands.defineCommand(
  ticketSpecs.attachFile,
  {
    examples: [
      {
        ...{
          args: { ticket: "cc#12", path: ".cc/temp/evidence.png" },
          flags: { description: "Observed rendering" },
        },
        why: "attachFile ticket context",
      },
    ],
    handler: async () => ({
      default: (await import("./attachments.handler")).attachFileHandler,
    }),
  },
);
export const attachConversationCommand = ccCommands.defineCommand(
  ticketSpecs.attachConversation,
  {
    examples: [
      {
        ...{
          args: { ticket: "cc#12" },
          flags: { description: "Design discussion" },
        },
        why: "attachConversation ticket context",
      },
    ],
    handler: async () => ({
      default: (await import("./attachments.handler"))
        .attachConversationHandler,
    }),
  },
);
export const attachSessionCommand = ccCommands.defineCommand(
  ticketSpecs.attachSession,
  {
    examples: [
      {
        ...{
          args: { ticket: "cc#12", "session-name": "previous-work" },
          flags: { description: "Earlier implementation" },
        },
        why: "attachSession ticket context",
      },
    ],
    handler: async () => ({
      default: (await import("./attachments.handler")).attachSessionHandler,
    }),
  },
);
export const attachNoteCommand = ccCommands.defineCommand(
  ticketSpecs.attachNote,
  {
    examples: [
      {
        ...{
          args: { ticket: "cc#12" },
          flags: { description: "Mechanism", markdown: "Boundary details" },
        },
        why: "attachNote ticket context",
      },
    ],
    handler: async () => ({
      default: (await import("./attachments.handler")).attachNoteHandler,
    }),
  },
);
export const attachmentGetCommand = ccCommands.defineCommand(
  ticketSpecs.attachmentGet,
  {
    examples: [
      {
        ...{ args: { ticket: "cc#12", "attachment-id": "attachment-one" } },
        why: "attachmentGet ticket context",
      },
    ],
    handler: async () => ({
      default: (await import("./attachments.handler")).attachmentGetHandler,
    }),
  },
);
export const attachmentUpdateCommand = ccCommands.defineCommand(
  ticketSpecs.attachmentUpdate,
  {
    examples: [
      {
        ...{
          args: { ticket: "cc#12", "attachment-id": "attachment-one" },
          flags: { description: "Revised rationale" },
        },
        why: "attachmentUpdate ticket context",
      },
    ],
    handler: async () => ({
      default: (await import("./attachments.handler")).attachmentUpdateHandler,
    }),
  },
);
export const attachmentRefreshCommand = ccCommands.defineCommand(
  ticketSpecs.attachmentRefresh,
  {
    examples: [
      {
        ...{ args: { ticket: "cc#12", "attachment-id": "attachment-one" } },
        why: "attachmentRefresh ticket context",
      },
    ],
    handler: async () => ({
      default: (await import("./attachments.handler")).attachmentRefreshHandler,
    }),
  },
);
export const attachmentRemoveCommand = ccCommands.defineCommand(
  ticketSpecs.attachmentRemove,
  {
    examples: [
      {
        ...{ args: { ticket: "cc#12", "attachment-id": "attachment-one" } },
        why: "attachmentRemove ticket context",
      },
    ],
    handler: async () => ({
      default: (await import("./attachments.handler")).attachmentRemoveHandler,
    }),
  },
);
export const exportCommand = ccCommands.defineCommand(ticketSpecs.export, {
  examples: [
    {
      ...{ args: { ticket: "cc#12" }, out: ".cc/temp/ticket.gz" },
      why: "export ticket context",
    },
  ],
  handler: async () => ({
    default: (await import("./bundles.handler")).exportHandler,
  }),
});
export const importCommand = ccCommands.defineCommand(ticketSpecs.import, {
  examples: [
    {
      ...{ flags: { archive: ".cc/temp/ticket.gz" } },
      why: "import ticket context",
    },
  ],
  handler: async () => ({
    default: (await import("./bundles.handler")).importHandler,
  }),
});
export const ticketCommands = [
  createCommand,
  listCommand,
  getCommand,
  updateCommand,
  deleteCommand,
  startCommand,
  relationListCommand,
  relationGetCommand,
  relationAddCommand,
  relationUpdateCommand,
  relationRemoveCommand,
  statusAddCommand,
  statusListCommand,
  statusGetCommand,
  attachFileCommand,
  attachConversationCommand,
  attachSessionCommand,
  attachNoteCommand,
  attachmentGetCommand,
  attachmentUpdateCommand,
  attachmentRefreshCommand,
  attachmentRemoveCommand,
  exportCommand,
  importCommand,
] as const;
export const ticketGroups = [
  defineGroup({
    path: "ticket",
    summary: "Track and execute project work",
    description:
      "Ticket references resolve as a project-local number or a qualified project#number.",
  }),
  defineGroup({
    path: "ticket relation",
    summary: "Maintain ticket relationships",
    description:
      "The server owns relationship direction, graph constraints, and paging.",
  }),
  defineGroup({
    path: "ticket status-update",
    summary: "Append and read progress records",
    description:
      "Status updates retain immutable author provenance and full-read handles.",
  }),
  defineGroup({
    path: "ticket attach",
    summary: "Attach reusable work context",
    description:
      "Attach files, conversations, sessions, or Markdown notes with a relevance description.",
  }),
  defineGroup({
    path: "ticket attachment",
    summary: "Resolve and maintain attachment context",
    description:
      "Read full context, update metadata, refresh conversation snapshots, or remove attachments.",
  }),
] as const;
