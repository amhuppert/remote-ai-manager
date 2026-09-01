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
const RELATIONSHIP_ROLES = "related|depends_on|blocks|parent|child";

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
      "create, list, read, update, link, post updates to, and attach context to work tickets",
    description:
      "Manage Command Center tickets — durable work items owned by one project, identified as <project>#<number>.",
    usage: [
      "cctl ticket <create|list|get|update|delete|start|relation|status-update|attach|attachment>",
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
      {
        command: "ticket relation",
        oneLiner: "manage structural links between tickets",
      },
      {
        command: "ticket status-update",
        oneLiner: "post and read append-only progress updates",
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
        fileSource: true,
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
      "List the ambient project's tickets, or every project's with --all. Filters combine; sort defaults to most recently updated. One row per ticket, capped at 20 — the leading count line names the exact command that reveals the rest. Each row carries its attachment count; --attachments adds the typed index for the rows shown, one request per ticket.",
    usage: [
      "cctl ticket list [--status <status>] [--type <type>] [--sort <created|updated>] [--all] [--limit <n>] [--attachments]",
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
      {
        name: "limit",
        kind: "value",
        valuePlaceholder: "<n>",
        description: "rows to print (default: 20)",
      },
      {
        name: "attachments",
        kind: "boolean",
        description:
          "render each shown ticket's attachment index with its retrieval commands",
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
      {
        invocation: "cctl ticket list --status in_progress --attachments",
        explanation:
          "adds each shown ticket's attachment ids and retrieval commands",
      },
    ],
    related: [
      { command: "ticket get", oneLiner: "read one ticket in full" },
      { command: "ticket create", oneLiner: "create a new ticket" },
      {
        command: "ticket attachment get",
        oneLiner: "retrieve one attachment listed by --attachments",
      },
    ],
  },
  {
    path: ["ticket", "get"],
    summary: "read one ticket with bounded collaboration outlines",
    description:
      "Read a ticket's fields, sessions, and attachment index plus at most 20 grouped relationship outlines and the five newest status-update outlines. Every outline carries its stable id and exact drill-down command; omission metadata names the full list command. A bare <number> resolves through the ambient project scope; <project>#<number> works from anywhere.",
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
      {
        command: "ticket relation list",
        oneLiner: "page through all relationships",
      },
      {
        command: "ticket status-update list",
        oneLiner: "page through the complete update log",
      },
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
      `cctl ticket start ${REF_PLACEHOLDER} --mode <agent|prepared> [--backend <backend>] [--model <model> [--model-param <id=value> ...]]`,
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
        valuePlaceholder: "<backend>",
        description: "backend for the immediate kickoff turn",
      },
      {
        name: "model",
        kind: "value",
        valuePlaceholder: "<model>",
        description: "backend model for the immediate kickoff turn",
      },
      {
        name: "model-param",
        kind: "value",
        valuePlaceholder: "<id=value>",
        description:
          "repeat for each catalog parameter in the immediate kickoff selection",
      },
    ],
    examples: [
      {
        invocation:
          "cctl ticket start 12 --mode agent --backend codex --model gpt-5.6-sol --model-param reasoning=ultra --model-param fast=true",
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
    path: ["ticket", "relation"],
    summary: "list, read, add, edit, and remove ticket relationships",
    description:
      "Manage durable relationships between tickets. Reads are bounded outlines with stable relationship ids; only 'get' returns a full Markdown rationale.",
    usage: ["cctl ticket relation <list|get|add|update|remove>"],
    flags: [],
    examples: [],
    domainContext:
      "Roles are relative to the ticket named first: depends_on/blocks and parent/child are inverse views of one directed edge; related is symmetric.\nBare references resolve independently through the ambient project, so qualify BOTH references when ambient scope is not intended.\nSetting a new parent atomically replaces the old parent. Dependencies are informational and never gate work.",
    related: [
      {
        command: "ticket get",
        oneLiner: "read the bounded relationship outline on a ticket",
      },
      {
        command: "ticket attach ticket",
        oneLiner: "retained compatibility alias for a related edge",
      },
      {
        command: "ticket status-update",
        oneLiner: "record progress separately from structural links",
      },
    ],
  },
  {
    path: ["ticket", "relation", "list"],
    summary: "list newest relationships as bounded outlines",
    description:
      "List relationship outlines newest-first, optionally filtered by the role relative to this ticket. Defaults to 20 and accepts at most 100; a truncated page returns an opaque cursor and the exact continuation command.",
    usage: [
      `cctl ticket relation list ${REF_PLACEHOLDER} [--role <${RELATIONSHIP_ROLES}>] [--limit <n>] [--cursor <opaque>]`,
    ],
    flags: [
      {
        name: "role",
        kind: "value",
        valuePlaceholder: `<${RELATIONSHIP_ROLES}>`,
        description: "filter by the role relative to the named ticket",
      },
      {
        name: "limit",
        kind: "value",
        valuePlaceholder: "<1-100>",
        description: "page size (default: 20; maximum: 100)",
      },
      {
        name: "cursor",
        kind: "value",
        valuePlaceholder: "<opaque>",
        description: "opaque continuation cursor returned by the previous page",
      },
    ],
    examples: [
      {
        invocation:
          "cctl ticket relation list command-center#12 --role depends_on --limit 20",
        explanation:
          "lists only prerequisites from command-center#12's perspective; pass a returned --cursor unchanged",
      },
    ],
    related: [
      { command: "ticket relation get", oneLiner: "read one full rationale" },
      { command: "ticket relation add", oneLiner: "add another relationship" },
      { command: "ticket get", oneLiner: "read the grouped ticket outline" },
    ],
  },
  {
    path: ["ticket", "relation", "get"],
    summary: "read one relationship and its full rationale",
    description:
      "Read one relationship by the stable id shown in a ticket or relation outline. This is the only relationship read that returns the full Markdown rationale; oversized output becomes an artifact under .cc/temp/.",
    usage: [`cctl ticket relation get ${REF_PLACEHOLDER} <relationshipId>`],
    flags: [],
    examples: [
      {
        invocation: "cctl ticket relation get command-center#12 rel-3f9a",
        explanation: "use the relationship id exactly as an outline printed it",
      },
    ],
    related: [
      { command: "ticket relation list", oneLiner: "find relationship ids" },
      { command: "ticket relation update", oneLiner: "edit this rationale" },
      { command: "ticket relation remove", oneLiner: "remove this edge" },
    ],
  },
  {
    path: ["ticket", "relation", "add"],
    summary: "add a relationship relative to one ticket",
    description:
      "Add one related, dependency, or hierarchy edge. Both ticket references resolve independently; qualify both when ambient scope is not intended. Graph, scope, self-link, and uniqueness refusals are server-authoritative and return typed rationales.",
    usage: [
      `cctl ticket relation add ${REF_PLACEHOLDER} <otherNumber | project#number> --role <${RELATIONSHIP_ROLES}> [--description "<markdown>"]`,
    ],
    flags: [
      {
        name: "role",
        kind: "value",
        valuePlaceholder: `<${RELATIONSHIP_ROLES}>`,
        description:
          "required — role of the other ticket relative to the first",
      },
      {
        name: "description",
        kind: "value",
        valuePlaceholder: '"<markdown>"',
        fileSource: true,
        description: "optional Markdown rationale; omission means no rationale",
      },
    ],
    examples: [
      {
        invocation:
          "cctl ticket relation add command-center#12 platform#7 --role depends_on --description-file .cc/temp/rationale.md",
        explanation:
          "qualifies both references for a cross-project dependency and reads shell-sensitive Markdown from a file",
      },
    ],
    related: [
      { command: "ticket relation list", oneLiner: "inspect existing edges" },
      { command: "ticket relation get", oneLiner: "read the created edge" },
      {
        command: "ticket attach ticket",
        oneLiner: "compatibility alias limited to related edges",
      },
    ],
  },
  {
    path: ["ticket", "relation", "update"],
    summary: "replace or clear a relationship rationale",
    description:
      "Replace the Markdown rationale without changing relationship identity. An explicit empty inline --description clears it; an empty file remains an invalid prose source.",
    usage: [
      `cctl ticket relation update ${REF_PLACEHOLDER} <relationshipId> --description "<markdown>"`,
    ],
    flags: [
      {
        name: "description",
        kind: "value",
        valuePlaceholder: '"<markdown>"',
        fileSource: true,
        allowEmpty: true,
        description:
          "required — replacement Markdown; an explicit empty inline value clears it",
      },
    ],
    examples: [
      {
        invocation: 'cctl ticket relation update 12 rel-3f9a --description=""',
        explanation:
          "clears the rationale while retaining the relationship and its stable id",
      },
    ],
    related: [
      { command: "ticket relation get", oneLiner: "read before editing" },
      {
        command: "ticket relation remove",
        oneLiner: "remove the edge instead",
      },
    ],
  },
  {
    path: ["ticket", "relation", "remove"],
    summary: "remove a relationship",
    description:
      "Remove one relationship by its stable id. Linked tickets remain; only the edge is deleted. Terminal: no hint.",
    usage: [`cctl ticket relation remove ${REF_PLACEHOLDER} <relationshipId>`],
    flags: [],
    examples: [
      {
        invocation: "cctl ticket relation remove 12 rel-3f9a",
        explanation: "removes the edge after reading it with relation get",
      },
    ],
    related: [
      { command: "ticket relation get", oneLiner: "review before removing" },
      { command: "ticket relation list", oneLiner: "find relationship ids" },
      {
        command: "ticket relation update",
        oneLiner: "retain it and edit the rationale",
      },
    ],
  },
  {
    path: ["ticket", "status-update"],
    summary: "post and read append-only ticket status updates",
    description:
      "Manage deliberate Markdown progress posts, separate from the ticket status field and automatic activity. Routine reads are bounded outlines; only 'get' returns a full body and provenance snapshot.",
    usage: ["cctl ticket status-update <add|list|get>"],
    flags: [],
    examples: [],
    domainContext:
      "Status updates are append-only: there are no edit or delete verbs.\nAgent attribution comes only from the authenticated caller's CC_CONVERSATION_ID; callers cannot override provenance with --conversation.",
    related: [
      {
        command: "ticket get",
        oneLiner: "read the five newest update outlines",
      },
      {
        command: "ticket relation",
        oneLiner: "manage structural links separately from progress posts",
      },
    ],
  },
  {
    path: ["ticket", "status-update", "add"],
    summary: "append a Markdown status update",
    description:
      "Append one non-empty Markdown progress post. Agent provenance is taken from CC_CONVERSATION_ID and cannot be supplied or overridden as payload; every local prose and identity error fails before the request.",
    usage: [
      `cctl ticket status-update add ${REF_PLACEHOLDER} --body "<markdown>"`,
    ],
    flags: [
      {
        name: "body",
        kind: "value",
        valuePlaceholder: '"<markdown>"',
        fileSource: true,
        description: "required — non-empty GitHub-flavored Markdown body",
      },
    ],
    examples: [
      {
        invocation:
          "cctl ticket status-update add 12 --body-file .cc/temp/status.md",
        explanation:
          "uses a file for Markdown containing quotes, backticks, dollars, or newlines",
      },
    ],
    related: [
      { command: "ticket status-update list", oneLiner: "read the update log" },
      { command: "ticket status-update get", oneLiner: "read one full update" },
    ],
  },
  {
    path: ["ticket", "status-update", "list"],
    summary: "list newest status updates as bounded outlines",
    description:
      "List update outlines newest-first with author kind, profile label, backend, conversation id, and a bounded body preview. Defaults to 20 and accepts at most 100; a truncated page returns an opaque cursor and exact continuation command.",
    usage: [
      `cctl ticket status-update list ${REF_PLACEHOLDER} [--limit <n>] [--cursor <opaque>]`,
    ],
    flags: [
      {
        name: "limit",
        kind: "value",
        valuePlaceholder: "<1-100>",
        description: "page size (default: 20; maximum: 100)",
      },
      {
        name: "cursor",
        kind: "value",
        valuePlaceholder: "<opaque>",
        description: "opaque continuation cursor returned by the previous page",
      },
    ],
    examples: [
      {
        invocation:
          "cctl ticket status-update list command-center#12 --limit 20",
        explanation:
          "pass the returned --cursor unchanged to continue without gaps or duplicates",
      },
    ],
    related: [
      { command: "ticket status-update get", oneLiner: "read one full body" },
      {
        command: "ticket status-update add",
        oneLiner: "append another update",
      },
      { command: "ticket get", oneLiner: "read the five newest outlines" },
    ],
  },
  {
    path: ["ticket", "status-update", "get"],
    summary: "read one full status update and provenance snapshot",
    description:
      "Read one update by the stable id shown in an outline. Returns the complete Markdown body and, for an agent author, the durable redacted conversation/profile provenance; oversized output becomes an artifact under .cc/temp/.",
    usage: [`cctl ticket status-update get ${REF_PLACEHOLDER} <updateId>`],
    flags: [],
    examples: [
      {
        invocation:
          "cctl ticket status-update get command-center#12 update-3f9a",
        explanation:
          "use the update id exactly as a list or ticket outline printed it",
      },
    ],
    related: [
      { command: "ticket status-update list", oneLiner: "find update ids" },
      { command: "ticket status-update add", oneLiner: "append a new post" },
    ],
  },
  {
    path: ["ticket", "attach"],
    summary: "attach described context to a ticket",
    description:
      "Attach one of four canonical context kinds (file, conversation, session, note). The retained ticket leaf is a compatibility-only alias for a related relationship and does not create an attachment. Every canonical attachment carries a required --description explaining what it contains and why it matters — the descriptions ARE the ticket's attachment index.",
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
      "Attach a conversation by id — CC globally resolves an explicit id to its owning project and session, ensures a compaction exists, and snapshots its markdown. With no <conversationId>, attaches the current conversation from the env identity.",
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
          "optional owning-session override (omit to resolve an explicit conversation id globally; defaults to CC_SESSION only when attaching the current conversation)",
      },
    ],
    examples: [
      {
        invocation:
          'cctl ticket attach conversation 12 --description "design discussion that produced this ticket"',
        explanation: "attaches the current conversation's compaction snapshot",
      },
      {
        invocation:
          'cctl ticket attach conversation 12 2542e6ad-6245-436f-a849-7b2da728129d --description "investigation from another session"',
        explanation:
          "resolves the conversation's owning project and session from its id; no --session flag is needed",
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
    summary: "compatibility alias for adding a related relationship",
    description:
      "Compatibility alias for 'ticket relation add --role related'. It calls the relationship route and never writes an attachment; use the relation command for new automation.",
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
      {
        command: "ticket relation add",
        oneLiner: "use the canonical relationship command",
      },
      { command: "ticket relation get", oneLiner: "read the rationale" },
    ],
  },
  {
    path: ["ticket", "attach", "note"],
    summary: "attach a markdown note",
    description:
      "Attach free-form markdown as inline context. The note body is the positional argument, or --markdown/--markdown-file when the text would not survive the shell; edit it later with 'ticket attachment update --markdown'.",
    usage: [
      `cctl ticket attach note ${REF_PLACEHOLDER} "<markdown>" --description "<what and why>"`,
    ],
    flags: [
      { ...descriptionFlag },
      {
        name: "markdown",
        kind: "value",
        valuePlaceholder: '"<markdown>"',
        fileSource: true,
        description: "the note body, as an alternative to the positional",
      },
    ],
    examples: [
      {
        invocation:
          'cctl ticket attach note 12 "Repro: run the suite twice; second run hits the stale cache." --description "reproduction steps"',
        explanation: "quote the markdown body — it is a single argument",
      },
      {
        invocation:
          'cctl ticket attach note 12 --markdown-file .cc/temp/note.md --description "reproduction steps"',
        explanation:
          "author the body in a file when it carries backticks, quotes, or newlines",
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
      "Operate on one attachment by its id (from the index shown by 'ticket get' or 'ticket list'). Migrated relationship ids remain readable, editable, and removable through this compatibility adapter; refresh stays conversation-only. Works in any ticket status, including after work has started.",
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
      "Resolve an attachment by kind: file content, conversation compaction markdown (live or retained snapshot), session state, related-ticket detail with its own index, or note markdown. Content that no longer exists exits 1. A file attachment past the stdout budget — and any binary (base64) file, whatever its size — is written under .cc/temp/ and stdout carries the manifest (path, format, byte count, SHA-256) instead of the content.",
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
      {
        command: "ticket list",
        oneLiner: "list attachment ids across tickets with --attachments",
      },
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
