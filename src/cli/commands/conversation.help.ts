import type { CommandHelpEntry } from "../help-types";

/**
 * Help-registry entries for `cctl conversation` (docs/design/cc-cli/04
 * §2.2/§2.4): the group hub, the read/compact leaves, and the `compaction`
 * group with its get/list leaves. The `read` entry declares the FULL selector
 * set (outline, message, message-range, seq-range, include-tools,
 * include-thinking, search, max-bytes, format): the entry IS the allowlist, so
 * an undeclared selector is a flag the command refuses (doc 04 §1.1).
 */
export const conversationHelpEntries: CommandHelpEntry[] = [
  {
    path: ["conversation"],
    dynamicContext: true,
    summary: "read conversation transcripts and manage compaction artifacts",
    description:
      "Read conversation transcripts in bounded windows and work with compaction artifacts — dense, structured context handoffs generated from a conversation's history. This is how an agent pulls context from another conversation (or its own earlier history) referenced via a <conversation-ref>. A <conversation-ref> carries ready-to-run read/compaction commands — copy them verbatim, no flags needed.",
    usage: ["cctl conversation <read|compact|compaction get|compaction list>"],
    flags: [],
    examples: [],
    related: [],
  },
  {
    path: ["conversation", "read"],
    dynamicContext: true,
    summary: "render a bounded window of a transcript",
    description:
      "Render a window of the transcript. Prefer `conversation compaction get` FIRST — it is the cheap 10–20 KB summary that is almost always all the context you need. Reach for `read` when the compaction points you at something or is stale/absent: `--outline` for the table of contents, then a narrow window. <conversation-id> is positional and defaults to CC_CONVERSATION_ID; for a conversation outside your session, cctl auto-resolves its owning project/session from the id. Invalid options exit 2 (one issue per line); an unknown conversation exits 2.",
    usage: [
      "cctl conversation read [<conversation-id>] [--outline] [--message N] [--message-range A:B] [--seq-range A:B] [--include-tools none|summary|full] [--include-thinking] [--search <regex>] [--max-bytes N] [--format json|markdown] [--json]",
    ],
    flags: [
      {
        name: "outline",
        kind: "boolean",
        description:
          "user prompts + assistant headlines only (the table of contents)",
      },
      {
        name: "message",
        kind: "value",
        valuePlaceholder: "N",
        description: "a single message by its #N message index",
      },
      {
        name: "message-range",
        kind: "value",
        valuePlaceholder: "A:B",
        description:
          "a window of message indexes (#N units); A:B, A-B, A,B, or N",
      },
      {
        name: "seq-range",
        kind: "value",
        valuePlaceholder: "A:B",
        description: "a window of raw JSONL seq lines ([sN] markers)",
      },
      {
        name: "include-tools",
        kind: "value",
        valuePlaceholder: "none|summary|full",
        description: "tool-call detail level (default summary)",
      },
      {
        name: "include-thinking",
        kind: "boolean",
        description: "include thinking blocks (default off)",
      },
      {
        name: "search",
        kind: "value",
        valuePlaceholder: "<regex>",
        description: "keep only units matching the regex",
      },
      {
        name: "max-bytes",
        kind: "value",
        valuePlaceholder: "N",
        description: "server-side output cap (default 256 KiB)",
      },
      {
        name: "format",
        kind: "value",
        valuePlaceholder: "json|markdown",
        description:
          "markdown prints a compact fenced document instead of JSON-derived text",
      },
    ],
    examples: [
      {
        invocation: "cctl conversation read 0197a3c2-... --outline",
        explanation:
          "start here — the TOC; its hint tells you whether a compaction exists to fetch instead",
      },
      {
        invocation:
          "cctl conversation read 0197a3c2-... --message-range 4:6 --include-tools summary",
        explanation:
          "ranges are A:B (colon) — the #1 friction; #N here are MESSAGE indexes, distinct from the [sN] seq markers windowed by --seq-range (don't mix the two)",
      },
    ],
    domainContext:
      "Two coordinate systems, do not mix them: the #N unit headers are MESSAGE indexes (--message / --message-range), while the [sN] line markers are SEQ coordinates — raw JSONL lines, windowed with --seq-range. Compaction source refs carry both (messageIndex + seqStart/seqEnd).",
    related: [
      {
        command: "conversation compaction get",
        oneLiner: "the cheap summary — read this BEFORE a full read",
      },
      {
        command: "conversation compact",
        oneLiner: "create/refresh the compaction when it is stale or absent",
      },
    ],
  },
  {
    path: ["conversation", "compact"],
    dynamicContext: true,
    summary: "create or refresh a compaction artifact",
    description:
      "Create or refresh a compaction artifact (the whole conversation, or one message with --message N). Without --wait it returns immediately ({ artifactId, status: pending, hint }) — it generates in the background. With --wait it polls until the artifact completes (exit 0), fails (exit 1 with the error), or a bounded timeout elapses. --force regenerates even when the existing artifact is fresh.",
    usage: [
      "cctl conversation compact <conversation-id> [--message N] [--force] [--wait] [--json]",
    ],
    flags: [
      {
        name: "message",
        kind: "value",
        valuePlaceholder: "N",
        description:
          "compact one message's artifact instead of the conversation-level one",
      },
      {
        name: "force",
        kind: "boolean",
        description: "regenerate even when the existing artifact is fresh",
      },
      {
        name: "wait",
        kind: "boolean",
        description:
          "poll until the artifact completes instead of returning pending",
      },
    ],
    examples: [
      {
        invocation: "cctl conversation compact 0197a3c2-... --wait",
        explanation:
          "creates the artifact and blocks until it is ready; then read it with `conversation compaction get`",
      },
    ],
    related: [
      {
        command: "conversation compaction get",
        oneLiner: "read the artifact this creates",
      },
      {
        command: "conversation read",
        oneLiner: "pull a raw window when the compaction is not enough",
      },
    ],
  },
  {
    path: ["conversation", "compaction"],
    dynamicContext: true,
    summary: "read compaction artifacts",
    description:
      "Read compaction artifacts — the full structured envelope (agent brief, current state, decisions, files, commands, blockers) or a list of a conversation's artifacts.",
    usage: ["cctl conversation compaction <get|list>"],
    flags: [],
    examples: [],
    related: [
      {
        command: "conversation compact",
        oneLiner: "create or refresh the artifact these commands read",
      },
    ],
  },
  {
    path: ["conversation", "compaction", "get"],
    dynamicContext: true,
    summary: "fetch the newest matching compaction envelope",
    description:
      "Fetch the newest matching artifact's FULL envelope (--message N selects that message's artifact; otherwise the conversation-level one). --format markdown renders the envelope as prose (brief, current state, decisions, files, commands, blockers with their #N sA–B source refs) — usually the right form to read; the JSON envelope additionally carries the refs' verbatim quotes. When stale it still succeeds (stale: true) with a refresh hint. When absent it exits 1 with a create hint — create it, then re-get.",
    usage: [
      "cctl conversation compaction get <conversation-id> [--message N] [--format json|markdown] [--json]",
    ],
    flags: [
      {
        name: "message",
        kind: "value",
        valuePlaceholder: "N",
        description:
          "select that message's artifact (else the conversation-level one)",
      },
      {
        name: "format",
        kind: "value",
        valuePlaceholder: "json|markdown",
        description:
          "markdown renders the envelope as prose (usually what you want to read)",
      },
    ],
    examples: [
      {
        invocation:
          "cctl conversation compaction get 0197a3c2-... --format markdown",
        explanation:
          "read this whole (10–20 KB) before any `read`; absent → exit 1 + create hint, so `conversation compact` then re-get",
      },
    ],
    related: [
      {
        command: "conversation compact",
        oneLiner: "create the artifact when this exits 1 (absent)",
      },
      {
        command: "conversation read",
        oneLiner: "pull the raw window a source ref points at",
      },
    ],
  },
  {
    path: ["conversation", "compaction", "list"],
    dynamicContext: true,
    summary: "list a conversation's compaction artifacts",
    description:
      "One line per artifact (id, kind, status, covered seq range, freshness). Ends with a hint pointing at `compaction get`.",
    usage: ["cctl conversation compaction list <conversation-id> [--json]"],
    flags: [],
    examples: [
      {
        invocation: "cctl conversation compaction list 0197a3c2-...",
        explanation:
          "see which artifacts exist and their freshness before fetching one with `compaction get`",
      },
    ],
    related: [
      {
        command: "conversation compaction get",
        oneLiner: "fetch a listed artifact's full envelope",
      },
    ],
  },
];
