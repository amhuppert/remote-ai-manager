import type { CommandHelpEntry } from "../help-types";

/**
 * Help-registry entries for `cctl ticket` — the group hub plus the CRUD leaves
 * (ticket-system design §CLI Contract). Flags match what `ticket.ts` actually
 * reads; the identifier forms (`<number>` in project scope, `<project>#<number>`
 * from anywhere) are taught on every leaf that takes a reference.
 */

const REF_PLACEHOLDER = "<number | project#number>";

const WORK_TYPES = "feature|bug|research|tech_debt|performance";
const STATUSES = "not_started|in_progress|done|blocked|closed";

const typeFlag = {
  name: "type",
  kind: "value" as const,
  valuePlaceholder: `<${WORK_TYPES}>`,
  description: "work type",
};

const statusFlag = {
  name: "status",
  kind: "value" as const,
  valuePlaceholder: `<${STATUSES}>`,
  description: "ticket status",
};

const descriptionFlag = {
  name: "description",
  kind: "value" as const,
  valuePlaceholder: '"<what and why>"',
  description:
    "required — what the attachment contains and why it matters (shown in the index)",
};

export const ticketHelpEntries: CommandHelpEntry[] = [
  {
    path: ["ticket"],
    summary:
      "create, list, read, update, delete, start work on, and attach context to work tickets",
    description:
      "Manage Command Center tickets — durable work items owned by one project, identified as <project>#<number>.",
    usage: [
      "cctl ticket <create|list|get|update|delete|start|attach|attachment>",
    ],
    flags: [],
    examples: [],
    domainContext:
      "A bare <number> resolves through the ambient project scope (--project / CC_PROJECT).\nThe <project>#<number> form addresses any project's tickets from any conversation, including graph-workflow lanes.",
    related: [
      {
        command: "ticket start",
        oneLiner: "provision a ready-to-work session for a ticket",
      },
      {
        command: "ticket attach",
        oneLiner: "attach described context to a ticket",
      },
      {
        command: "ticket attachment",
        oneLiner: "read, edit, or remove attached context",
      },
    ],
  },
  {
    path: ["ticket", "create"],
    summary: "create a ticket in the ambient project",
    description:
      "Create a ticket in the ambient project scope. Status defaults to not_started when --status is omitted. Prints the new ticket's <project>#<number> identifier.",
    usage: [
      `cctl ticket create --title "<title>" --type <${WORK_TYPES}> [--description "<markdown>"] [--status <${STATUSES}>]`,
    ],
    flags: [
      {
        name: "title",
        kind: "value",
        valuePlaceholder: '"<title>"',
        description: "required — short ticket title",
      },
      { ...typeFlag, description: "required — work type" },
      {
        name: "description",
        kind: "value",
        valuePlaceholder: '"<markdown>"',
        description: "optional markdown description",
      },
      statusFlag,
    ],
    examples: [
      {
        invocation:
          'cctl ticket create --title "Flaky pre-merge gate" --type bug --description "Fails ~1 in 5 runs on the vitest step."',
        explanation:
          "creates the ticket with the default not_started status and prints its identifier",
      },
    ],
    related: [
      { command: "ticket list", oneLiner: "see the project's tickets" },
      { command: "ticket get", oneLiner: "read a ticket after creating it" },
    ],
  },
  {
    path: ["ticket", "list"],
    summary: "list tickets with filters",
    description:
      "List the ambient project's tickets, or every project's with --all. Filters combine; sort defaults to most recently updated.",
    usage: [
      "cctl ticket list [--status <status>] [--type <type>] [--sort <created|updated>] [--all]",
    ],
    flags: [
      statusFlag,
      typeFlag,
      {
        name: "sort",
        kind: "value",
        valuePlaceholder: "<created|updated>",
        description: "sort order (default: updated)",
      },
      {
        name: "all",
        kind: "boolean",
        description: "list tickets across every project",
      },
    ],
    examples: [
      {
        invocation: "cctl ticket list --status in_progress --sort created",
        explanation: "the ambient project's in-progress tickets, newest first",
      },
      {
        invocation: "cctl ticket list --all",
        explanation:
          "tickets across every project — entries show <project>#<number> for cross-scope follow-ups",
      },
    ],
    related: [
      { command: "ticket get", oneLiner: "read one ticket in full" },
      { command: "ticket create", oneLiner: "create a new ticket" },
    ],
  },
  {
    path: ["ticket", "get"],
    summary: "read one ticket in full",
    description:
      "Read a ticket's fields, sessions, and attachment index. A bare <number> resolves through the ambient project scope; <project>#<number> works from anywhere.",
    usage: [`cctl ticket get ${REF_PLACEHOLDER}`],
    flags: [],
    examples: [
      {
        invocation: "cctl ticket get 12",
        explanation: "ticket 12 of the ambient project",
      },
      {
        invocation: "cctl ticket get command-center#12",
        explanation:
          "cross-scope form — works without (or ignoring) the ambient project",
      },
    ],
    related: [
      { command: "ticket update", oneLiner: "change fields or status" },
      { command: "ticket list", oneLiner: "find ticket numbers" },
    ],
  },
  {
    path: ["ticket", "update"],
    summary: "update a ticket's fields or status",
    description:
      "Update any combination of --title, --description, --type, and --status. Every explicit status transition is permitted.",
    usage: [
      `cctl ticket update ${REF_PLACEHOLDER} [--title "<title>"] [--description "<markdown>"] [--type <type>] [--status <status>]`,
    ],
    flags: [
      {
        name: "title",
        kind: "value",
        valuePlaceholder: '"<title>"',
        description: "new title",
      },
      {
        name: "description",
        kind: "value",
        valuePlaceholder: '"<markdown>"',
        description: "new markdown description (replaces the old one)",
      },
      typeFlag,
      statusFlag,
    ],
    examples: [
      {
        invocation: "cctl ticket update 12 --status blocked",
        explanation: "move ticket 12 to blocked; any transition is allowed",
      },
    ],
    related: [
      { command: "ticket get", oneLiner: "read the ticket before editing" },
      { command: "ticket delete", oneLiner: "remove a ticket entirely" },
    ],
  },
  {
    path: ["ticket", "delete"],
    summary: "delete a ticket",
    description:
      "Delete a ticket and its attachments. Its number is never reused. Terminal: no hint.",
    usage: [`cctl ticket delete ${REF_PLACEHOLDER}`],
    flags: [],
    examples: [
      {
        invocation: "cctl ticket delete command-center#12",
        explanation: "deletes the ticket; the identifier is confirmed back",
      },
    ],
    related: [
      { command: "ticket list", oneLiner: "find the ticket to delete" },
      { command: "ticket get", oneLiner: "review a ticket before deleting" },
    ],
  },
  {
    path: ["ticket", "start"],
    summary: "start work on a ticket in a new session",
    description:
      "Provision a ready-to-work session for the ticket: attachments and conversation summaries are materialized into the worktree, a ticket charter is activated, the session is linked, and the ticket moves to in_progress. --mode agent queues an immediate first agent turn built from the ticket; --mode prepared leaves the session idle until the user's first prompt. A ticket with an active linked session is rejected naming that session.",
    usage: [
      `cctl ticket start ${REF_PLACEHOLDER} --mode <agent|prepared> [--backend <claude|codex> --model <model> --effort <level>]`,
    ],
    flags: [
      {
        name: "mode",
        kind: "value",
        valuePlaceholder: "<agent|prepared>",
        description:
          "required — agent begins working immediately; prepared waits for the user's first prompt",
      },
      {
        name: "backend",
        kind: "value",
        valuePlaceholder: "<claude|codex>",
        description: "backend for the immediate kickoff turn",
      },
      {
        name: "model",
        kind: "value",
        valuePlaceholder: "<model>",
        description: "backend model for the immediate kickoff turn",
      },
      {
        name: "effort",
        kind: "value",
        valuePlaceholder: "<minimal|low|medium|high|xhigh|max|ultra>",
        description: "reasoning effort for the immediate kickoff turn",
      },
    ],
    examples: [
      {
        invocation:
          "cctl ticket start 12 --mode agent --backend codex --model gpt-5.6-sol --effort ultra",
        explanation:
          "provisions the session and queues the kickoff turn from the ticket's title, description, and attachment index",
      },
      {
        invocation: "cctl ticket start command-center#12 --mode prepared",
        explanation:
          "provisions the session with materialized context, then waits for the user's first prompt",
      },
    ],
    related: [
      { command: "ticket get", oneLiner: "review the ticket before starting" },
      {
        command: "ticket update",
        oneLiner: "adjust status manually (finish, block, close)",
      },
    ],
  },
  {
    path: ["ticket", "attach"],
    summary: "attach described context to a ticket",
    description:
      "Attach one of five context kinds to a ticket. Every attachment carries a required --description explaining what it contains and why it matters — the descriptions ARE the ticket's attachment index.",
    usage: [
      `cctl ticket attach <file|conversation|session|ticket|note> ${REF_PLACEHOLDER} … --description "<what and why>"`,
    ],
    flags: [],
    examples: [],
    related: [
      {
        command: "ticket attachment",
        oneLiner: "read, edit, or remove attached context",
      },
    ],
  },
  {
    path: ["ticket", "attach", "file"],
    summary: "attach a file snapshot",
    description:
      "Snapshot a file's bytes at attach time — the attachment stays readable after the source file is deleted. The upload is capped server-side (oversized files are rejected).",
    usage: [
      `cctl ticket attach file ${REF_PLACEHOLDER} <path> --description "<what and why>" [--media-type <mime>]`,
    ],
    flags: [
      { ...descriptionFlag },
      {
        name: "media-type",
        kind: "value",
        valuePlaceholder: "<mime>",
        description: "optional media type recorded with the snapshot",
      },
    ],
    examples: [
      {
        invocation:
          'cctl ticket attach file 12 logs/ci-failure.txt --description "full CI log of the flaky run"',
        explanation:
          "captures the file's current bytes; retrieve later with 'cctl ticket attachment get 12 <id>'",
      },
    ],
    related: [
      { command: "ticket attachment get", oneLiner: "retrieve the snapshot" },
      { command: "ticket get", oneLiner: "see the ticket's attachment index" },
    ],
  },
  {
    path: ["ticket", "attach", "conversation"],
    summary: "attach a conversation's compaction snapshot",
    description:
      "Attach a conversation by id — CC ensures a compaction exists and snapshots its markdown. With no <conversationId>, attaches the current conversation from the env identity.",
    usage: [
      `cctl ticket attach conversation ${REF_PLACEHOLDER} [<conversationId>] --description "<what and why>"`,
    ],
    flags: [
      { ...descriptionFlag },
      {
        name: "conversation",
        kind: "value",
        valuePlaceholder: "<id>",
        description:
          "conversation to attach (defaults to CC_CONVERSATION_ID — the current conversation)",
      },
      {
        name: "session",
        kind: "value",
        valuePlaceholder: "<name>",
        description:
          "session recorded with the attachment (defaults to CC_SESSION only when attaching the current conversation)",
      },
    ],
    examples: [
      {
        invocation:
          'cctl ticket attach conversation 12 --description "design discussion that produced this ticket"',
        explanation: "attaches the current conversation's compaction snapshot",
      },
    ],
    related: [
      {
        command: "conversation compaction get",
        oneLiner: "read a compaction directly",
      },
      { command: "ticket attachment get", oneLiner: "retrieve the snapshot" },
    ],
  },
  {
    path: ["ticket", "attach", "session"],
    summary: "attach a live session pointer",
    description:
      "Attach a session of the ambient project as a live pointer — it resolves to the session's current state when read.",
    usage: [
      `cctl ticket attach session ${REF_PLACEHOLDER} <sessionName> --description "<what and why>"`,
    ],
    flags: [{ ...descriptionFlag }],
    examples: [
      {
        invocation:
          'cctl ticket attach session 12 csm/fix-gate --description "session where the fix is being developed"',
        explanation: "the pointer stays useful while the session exists",
      },
    ],
    related: [
      { command: "ticket attachment get", oneLiner: "resolve the session" },
    ],
  },
  {
    path: ["ticket", "attach", "ticket"],
    summary: "attach a related ticket",
    description:
      "Link another ticket as context. The reference resolves to the related ticket's current detail when read; a deleted related ticket yields a typed unavailable result.",
    usage: [
      `cctl ticket attach ticket ${REF_PLACEHOLDER} <relatedNumber | project#number> --description "<how it relates>"`,
    ],
    flags: [{ ...descriptionFlag }],
    examples: [
      {
        invocation:
          'cctl ticket attach ticket 12 command-center#7 --description "blocks the release this ticket targets"',
        explanation: "both identifier forms work for the related ticket too",
      },
    ],
    related: [
      { command: "ticket get", oneLiner: "follow the related ticket" },
      { command: "ticket attachment get", oneLiner: "resolve the link" },
    ],
  },
  {
    path: ["ticket", "attach", "note"],
    summary: "attach a markdown note",
    description:
      "Attach free-form markdown as inline context. The note body is the positional argument; edit it later with 'ticket attachment update --markdown'.",
    usage: [
      `cctl ticket attach note ${REF_PLACEHOLDER} "<markdown>" --description "<what and why>"`,
    ],
    flags: [{ ...descriptionFlag }],
    examples: [
      {
        invocation:
          'cctl ticket attach note 12 "Repro: run the suite twice; second run hits the stale cache." --description "reproduction steps"',
        explanation: "quote the markdown body — it is a single argument",
      },
    ],
    related: [
      { command: "ticket attachment update", oneLiner: "edit the note later" },
    ],
  },
  {
    path: ["ticket", "attachment"],
    summary: "read, edit, refresh, and remove ticket attachments",
    description:
      "Operate on one attachment by its id (from the index shown by 'ticket get' or 'ticket list'). Works in any ticket status, including after work has started.",
    usage: [
      `cctl ticket attachment <get|update|refresh|remove> ${REF_PLACEHOLDER} <attachmentId>`,
    ],
    flags: [],
    examples: [],
    related: [
      { command: "ticket attach", oneLiner: "add new context to a ticket" },
      { command: "ticket get", oneLiner: "list attachment ids in the index" },
    ],
  },
  {
    path: ["ticket", "attachment", "get"],
    summary: "retrieve an attachment's full content",
    description:
      "Resolve an attachment by kind: file content, conversation compaction markdown (live or retained snapshot), session state, related-ticket detail with its own index, or note markdown. Content that no longer exists exits 1.",
    usage: [`cctl ticket attachment get ${REF_PLACEHOLDER} <attachmentId>`],
    flags: [],
    examples: [
      {
        invocation: "cctl ticket attachment get command-center#12 att-3f9a",
        explanation:
          "the attachment id comes from the index in 'ticket get' output",
      },
    ],
    related: [
      {
        command: "ticket get",
        oneLiner: "the index that lists attachment ids",
      },
      { command: "ticket attachment update", oneLiner: "edit what you found" },
    ],
  },
  {
    path: ["ticket", "attachment", "update"],
    summary: "edit an attachment's description or note body",
    description:
      "Update the description of any attachment, and the markdown body of a note. At least one field flag is required.",
    usage: [
      `cctl ticket attachment update ${REF_PLACEHOLDER} <attachmentId> [--description "<what and why>"] [--markdown "<note body>"]`,
    ],
    flags: [
      {
        name: "description",
        kind: "value",
        valuePlaceholder: '"<what and why>"',
        description: "new description for the index",
      },
      {
        name: "markdown",
        kind: "value",
        valuePlaceholder: '"<note body>"',
        description: "new note body (note attachments only)",
      },
    ],
    examples: [
      {
        invocation:
          'cctl ticket attachment update 12 att-3f9a --description "narrowed to the cache layer"',
        explanation: "sharpen a description as understanding improves",
      },
    ],
    related: [
      { command: "ticket attachment get", oneLiner: "read before editing" },
      { command: "ticket attachment remove", oneLiner: "remove it instead" },
    ],
  },
  {
    path: ["ticket", "attachment", "refresh"],
    summary: "retry a conversation snapshot capture",
    description:
      "Retry snapshot capture for a pending or failed conversation attachment. The operation is compare-and-swap safe when another refresher or ticket start wins first.",
    usage: [`cctl ticket attachment refresh ${REF_PLACEHOLDER} <attachmentId>`],
    flags: [],
    examples: [
      {
        invocation: "cctl ticket attachment refresh 12 att-3f9a",
        explanation:
          "captures the conversation compaction and adopts it if this retry wins",
      },
    ],
    related: [
      {
        command: "ticket attachment get",
        oneLiner: "check snapshot state and retrieve captured content",
      },
      {
        command: "ticket attachment remove",
        oneLiner: "remove unavailable context",
      },
    ],
  },
  {
    path: ["ticket", "attachment", "remove"],
    summary: "remove an attachment",
    description:
      "Remove an attachment from the ticket's index; snapshotted content is cleaned up best-effort. Terminal: no hint.",
    usage: [`cctl ticket attachment remove ${REF_PLACEHOLDER} <attachmentId>`],
    flags: [],
    examples: [
      {
        invocation: "cctl ticket attachment remove 12 att-3f9a",
        explanation: "the removal is confirmed with the attachment id",
      },
    ],
    related: [
      { command: "ticket attachment get", oneLiner: "review before removing" },
    ],
  },
];
