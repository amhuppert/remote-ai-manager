import { z } from "zod";

import {
  memoryIndexModeSchema,
  memoryKindSchema,
  memoryLifecycleSchema,
  memoryLinkKindSchema,
  memoryScopeSchema,
} from "@/lib/memory/schemas";

import type { CommandHelpEntry, FlagSpec } from "../help-types";

/**
 * Help-registry entries for `cctl memory` — the agent surface over Command
 * Center's shared memory (spec R12). Flags match what `memory.ts` actually
 * reads; the registry is what derives the allowlist, the parser's boolean set,
 * and the rendered flag list, so this file is the wiring, not a description of
 * it.
 *
 * Every verb that addresses a note takes its SLUG. Internal memory ids exist and
 * resolve in the same argument position, but they never appear in default text
 * output — the slug is the handle an agent reads, writes, and links by, and a
 * rename leaves the old one behind as a resolving alias so a learned handle
 * never strands.
 */

const SLUG_PLACEHOLDER = "<slug>";

/**
 * An enum flag's placeholder, read off the SCHEMA the command validates
 * against. Hand-written alternations drift: this file advertised memory kinds
 * `fact` and `reference`, which the schema rejects, while hiding `procedure`,
 * which it accepts — so a caller following the generated help was refused for
 * obeying it. Deriving makes that class of defect unrepresentable.
 */
function optionsPlaceholder(schema: z.ZodType<string>): string {
  const json = z.toJSONSchema(schema) as { enum?: unknown };
  const options = Array.isArray(json.enum) ? json.enum.map(String) : [];
  if (options.length === 0) {
    throw new Error("optionsPlaceholder: schema declares no enum members");
  }
  return `<${options.join("|")}>`;
}

const scopeFlag: FlagSpec = {
  name: "scope",
  kind: "value",
  valuePlaceholder: optionsPlaceholder(memoryScopeSchema),
  description:
    "narrow the handle to one scope — the disambiguation a bare slug in two scopes asks for",
};

const ifRevisionFlag: FlagSpec = {
  name: "if-revision",
  kind: "value",
  valuePlaceholder: "<n>",
  description:
    "the revision this write is based on, from the read that produced it",
};

const hookFlag: FlagSpec = {
  name: "hook",
  kind: "value",
  valuePlaceholder: '"<one line>"',
  fileSource: true,
  description:
    "the single dense line the index carries: the hook is the whole index entry, so state a fact that stands alone",
};

const bodyFlag: FlagSpec = {
  name: "body",
  kind: "value",
  valuePlaceholder: '"<markdown>"',
  fileSource: true,
  description: "the note's markdown prose, capped at 8 KiB",
};

const statusNoteFlag: FlagSpec = {
  name: "status-note",
  kind: "value",
  valuePlaceholder: '"<one line>"',
  fileSource: true,
  description:
    "the perishable caveat, leased separately from the durable body — a caveat goes in the statusNote, never in the hook; 'none' clears it",
};

const indexModeFlag: FlagSpec = {
  name: "index-mode",
  kind: "value",
  valuePlaceholder: optionsPlaceholder(memoryIndexModeSchema),
  description:
    "auto competes, always reserves a slot, search-only never competes — always is for a trap that bites regardless of the task, search-only for reference material recall should find instead",
};

const aliasFlag: FlagSpec = {
  name: "alias",
  kind: "value",
  valuePlaceholder: "<text>",
  repeatable: true,
  description: "another name this note answers to; repeat for several",
};

const artifactFlag: FlagSpec = {
  name: "artifact",
  kind: "value",
  valuePlaceholder: "<handle>",
  description:
    "ticket:<number>, ticket:<project>#<number> or ticket:<id>, spec:<id>, execution:<id>, context:<executionId>/<contextId>, or session:<name>@<createdAt>",
};

const linkKindFlag: FlagSpec = {
  name: "kind",
  kind: "value",
  valuePlaceholder: optionsPlaceholder(memoryLinkKindSchema),
  description:
    "about is a relevance cue, source is provenance (default: about)",
};

const reviewAfterFlag: FlagSpec = {
  name: "review-after",
  kind: "value",
  valuePlaceholder: "<iso8601|none>",
  description:
    "when this note is due for review; 'none' means it never leases out",
};

const expiresAtFlag: FlagSpec = {
  name: "expires-at",
  kind: "value",
  valuePlaceholder: "<iso8601|none>",
  description:
    "when this note stops being delivered entirely; 'none' clears it",
};

export const memoryHelpEntries: CommandHelpEntry[] = [
  {
    path: ["memory"],
    summary: "recall, capture, and maintain Command Center's shared memory",
    description:
      "Read and write the memory Command Center shares across Claude, Codex, and Cursor. Your first turn is given the full <memory-index> block and later turns only a <memory-index-delta> of what changed, so reach for recall when the block is not enough, and for create when you learned something a future conversation would pay to know.",
    usage: [
      "cctl memory <recall|index|list|get|create|update|link|unlink|mark-reviewed|observe-rederivation|promote|review|archive|delete|export>",
    ],
    flags: [],
    examples: [],
    domainContext:
      "A note is addressed by its slug; internal ids resolve too but never appear in text output, and a rename keeps the old slug as an alias.\nScope decides reach: global (approval-gated for agents), project, and session — a session note binds to the exact incarnation and dies with it.\nWriting one: the hook is the whole index entry, so state a fact that stands alone rather than a topic, and put in the body only the mechanism or the exact command a reader would open it for.\nIndex mode decides how it reaches the block: auto competes, always reserves a slot, search-only never competes — always is for a trap that bites regardless of the task, search-only for reference material recall should find instead.\nLink a note to the ticket, spec, or workflow it is about and it leads the index of every conversation working that artifact.\nA perishable caveat goes in the statusNote, never in the hook, so a stale status withholds one line rather than the note; a fact a live artifact answers is not recorded at all.\nThe block is budgeted and omits hooks, so when a turn touches something it does not list, recall before you conclude.",
    related: [
      {
        command: "memory recall",
        oneLiner: "one bounded read when the index hook is not enough",
      },
      {
        command: "memory create",
        oneLiner: "capture a lesson a future conversation would pay to know",
      },
      {
        command: "memory review",
        oneLiner: "what has gone stale or is waiting to be promoted",
      },
    ],
  },
  {
    path: ["memory", "recall"],
    summary: "read a bounded pack of the memory most relevant to a question",
    description:
      "One retrieval call, bounded by a character budget. With a query it searches slugs, aliases, hooks, and bodies; with --related it answers from the notes linked to one artifact; with neither it returns what is most relevant to this conversation right now. The closing line states showing-N-of-M and the exact command that narrows further. This is what the index block's omission line is asking for: the block is budgeted and omits hooks, so when a turn touches something it does not list, recall before you conclude. Each hit is the hook plus what the body holds, and a body is worth opening for the mechanism or the exact command it carries.",
    usage: [
      'cctl memory recall ["<query>"] [--related <handle>] [--scope <scope>] [--budget <chars>]',
    ],
    flags: [
      {
        name: "related",
        kind: "value",
        valuePlaceholder: "<handle>",
        description:
          "answer from the notes linked to one artifact (same handle forms as 'memory link --artifact')",
      },
      scopeFlag,
      {
        name: "budget",
        kind: "value",
        valuePlaceholder: "<chars>",
        description: "character ceiling for the pack (default: 6000)",
      },
    ],
    examples: [
      {
        invocation: "cctl memory recall 'turbopack build is slow'",
        explanation:
          "single quotes, not double — a double-quoted query carrying a backtick is substituted by the shell before cctl sees it",
      },
      {
        invocation: "cctl memory recall --related ticket:74",
        explanation:
          "everything linked to one ticket, ranked with its about-linked notes first",
      },
    ],
    related: [
      {
        command: "memory get",
        oneLiner: "read one record from the pack in full",
      },
      {
        command: "memory index",
        oneLiner: "see the block a conversation already gets for free",
      },
    ],
  },
  {
    path: ["memory", "index"],
    summary: "render the memory block a conversation is due on its next turn",
    description:
      "Prints the <memory-index> block due for a conversation as it stands, composed by the same composer a turn uses and read from the same delivery state, so what you get is the block that conversation is owed rather than an approximation of it. That default is the NEXT-TURN delivery: the full index for a conversation that holds none, and a <memory-index-delta> of what changed for one that already does. Three things are supplied by whoever DISPATCHES the next turn rather than held by the conversation, so nothing outside a turn can read them and this default does not predict them — the model named on submission, a structured-output schema the request carries, and a graph-workflow lane's write envelope, composed from placement as the turn starts. A turn dispatched with any of the three different from what its runtime is running rebuilds that runtime, and unless a stored resume handle carries the conversation across that rebuild it is given a full block where this printed a delta; --full shows you that block now. --full renders the whole index whatever the conversation is due, which is what to read when you want everything it can be told rather than what it is about to be told. Neither render settles or resets anything, so previewing never spends the block the turn is owed. Whichever you read, it is budgeted and its omission line counts what did not fit, so when a turn touches something the block does not list, recall before you conclude. Stdout carries no trailing newline, and a conversation that would be told nothing prints nothing at all: the explanation goes to stderr. Defaults to the calling conversation. There is no project- or session-level preview: a block is composed for one conversation. Stderr also heads the output with any backend whose own native memory Command Center could not disable, so you know provider memory may coexist with CC memory; a missing disable mechanism does not establish whether provider memory is active.",
    usage: ["cctl memory index [--conversation <id>] [--full]"],
    flags: [
      {
        name: "conversation",
        kind: "value",
        valuePlaceholder: "<id>",
        description:
          "the conversation whose block to render (default: the calling conversation)",
      },
      {
        name: "full",
        kind: "boolean",
        description:
          "render the whole index rather than the delta the next turn is due — every hook the budget allows, not just what changed",
      },
    ],
    examples: [
      {
        invocation: "cctl memory index",
        explanation:
          "what your own next turn is due as things stand — a <memory-index-delta>, which carries only what changed since your last turn, once you already hold a block; nothing changed prints one line",
      },
      {
        invocation: "cctl memory index --full",
        explanation:
          "the whole index with its withheld and omitted counts, whatever your next turn is due",
      },
    ],
    related: [
      {
        command: "memory recall",
        oneLiner: "read past what the block had budget for",
      },
      {
        command: "memory list",
        oneLiner: "every note in scope, not just the block",
      },
    ],
  },
  {
    path: ["memory", "list"],
    summary: "list the notes visible to this conversation with their slugs",
    description:
      "One row per note — slug, scope, kind, and hook — bounded at 20 rows with the count line naming the command that reveals the rest. Archived notes are hidden unless --archived asks for them.",
    usage: [
      "cctl memory list [--scope <scope>] [--lifecycle <lifecycle>] [--archived] [--limit <n>]",
    ],
    flags: [
      scopeFlag,
      {
        name: "lifecycle",
        kind: "value",
        valuePlaceholder: optionsPlaceholder(memoryLifecycleSchema),
        description:
          "only notes in one lifecycle state — 'proposed' is the global-note approval queue",
      },
      {
        name: "archived",
        kind: "boolean",
        description: "include archived notes (hidden by default)",
      },
      {
        name: "limit",
        kind: "value",
        valuePlaceholder: "<n>",
        description: "rows to print (default: 20)",
      },
    ],
    examples: [
      {
        invocation: "cctl memory list --scope session",
        explanation:
          "only this session incarnation's own notes, the ones that die with it",
      },
      {
        invocation: "cctl memory list --lifecycle proposed",
        explanation:
          "global notes an agent proposed that are waiting for a human decision",
      },
    ],
    related: [
      { command: "memory get", oneLiner: "read one row's note in full" },
      { command: "memory review", oneLiner: "only what needs attention" },
    ],
  },
  {
    path: ["memory", "get"],
    summary: "read one note in full, with its links and current revision",
    description:
      "Prints the note's hook, body, status line with its age, scope, kind, lifecycle, and every artifact it is linked to. The revision this prints is the one a following update, archive, or promote passes to --if-revision.",
    usage: [
      `cctl memory get ${SLUG_PLACEHOLDER} [--scope <scope>] [--archived]`,
    ],
    flags: [
      scopeFlag,
      {
        name: "archived",
        kind: "boolean",
        description:
          "resolve an archived note too (a bare slug matches active records only)",
      },
    ],
    examples: [
      {
        invocation: "cctl memory get turbopack-build-memory",
        explanation:
          "the slug comes from an index hook, a recall pack, or a list row",
      },
      {
        invocation: "cctl memory get shared-state-db --scope project",
        explanation:
          "the narrowing an ambiguous-slug refusal names when a global and a project note share a slug",
      },
    ],
    related: [
      { command: "memory update", oneLiner: "correct what you just read" },
      { command: "memory list", oneLiner: "find the slug to read" },
    ],
  },
  {
    path: ["memory", "create"],
    summary: "capture a new note in global, project, or session scope",
    description:
      "Writes one note. The hook is the whole index entry, so state a fact that stands alone rather than a topic, and open a body only for the mechanism or the exact command. Index mode decides how it reaches the block: auto competes, always reserves a slot, search-only never competes — always is for a trap that bites regardless of the task, search-only for reference material recall should find instead. A global note created by an agent lands as a proposal and is delivered to nobody until a human approves it. Overlapping notes and a vague hook come back as advisory output beside the created note, never as a refusal. Follow it with 'cctl memory link' for the ticket, spec, or workflow it is about, so the note leads the index of every conversation working that artifact.",
    usage: [
      'cctl memory create --hook "<one line>" [--body "<markdown>"] [--scope <scope>] [--kind <kind>] [--slug <slug>] [--alias <text>] [--status-note "<line>"] [--index-mode <mode>] [--review-after <iso>] [--expires-at <iso>] [--supersedes <slug>]',
    ],
    flags: [
      hookFlag,
      bodyFlag,
      {
        name: "scope",
        kind: "value",
        valuePlaceholder: optionsPlaceholder(memoryScopeSchema),
        description:
          "where the note lives (default: project); global is approval-gated for agents",
      },
      {
        name: "kind",
        kind: "value",
        valuePlaceholder: optionsPlaceholder(memoryKindSchema),
        description:
          "what sort of knowledge this is (default: lesson); state is session-only working memory on a short lease",
      },
      {
        name: "slug",
        kind: "value",
        valuePlaceholder: "<slug>",
        description:
          "the handle to address it by (default: derived from the hook and made collision-safe)",
      },
      aliasFlag,
      statusNoteFlag,
      indexModeFlag,
      reviewAfterFlag,
      expiresAtFlag,
      {
        name: "supersedes",
        kind: "value",
        valuePlaceholder: "<slug>",
        description:
          "the note this one replaces — it is archived in the same write and points here",
      },
    ],
    examples: [
      {
        invocation:
          "cctl memory create --hook 'next build opens the LIVE db, so a main-branch schema bump breaks older branches'",
        explanation:
          "a project lesson; the slug is derived from the hook and made collision-safe",
      },
      {
        invocation:
          "cctl memory create --scope session --kind state --hook 'the halted exec blocks cctl validate until it is abandoned'",
        explanation:
          "working state that dies with this session incarnation rather than outliving it",
      },
    ],
    related: [
      {
        command: "memory update",
        oneLiner: "correct a note that already exists",
      },
      {
        command: "memory link",
        oneLiner: "bind the note to the artifact it is about",
      },
    ],
  },
  {
    path: ["memory", "update"],
    summary: "correct a note under compare-and-swap",
    description:
      "Edits hook, body, status line, aliases, slug, index mode, or leases. A perishable caveat goes in the statusNote, never in the hook, so --status-note re-leases the caveat alone and 'none' clears it; --index-mode moves how the note reaches the block, where auto competes, always reserves a slot, search-only never competes — always is for a trap that bites regardless of the task, search-only for reference material recall should find instead. --if-revision is the revision you read; a write based on a superseded revision is refused naming the current one, so a concurrent edit is never silently overwritten. Renaming with --slug keeps the old slug as a resolving alias.",
    usage: [
      `cctl memory update ${SLUG_PLACEHOLDER} --if-revision <n> [--hook "<line>"] [--body "<markdown>"] [--slug <new-slug>] [--alias <text>] [--status-note "<line>"] [--index-mode <mode>] [--review-after <iso>] [--expires-at <iso>] [--scope <scope>]`,
    ],
    flags: [
      ifRevisionFlag,
      hookFlag,
      bodyFlag,
      {
        name: "slug",
        kind: "value",
        valuePlaceholder: "<slug>",
        description: "rename — the old slug stays behind as an alias",
      },
      aliasFlag,
      statusNoteFlag,
      indexModeFlag,
      reviewAfterFlag,
      expiresAtFlag,
      scopeFlag,
    ],
    examples: [
      {
        invocation:
          "cctl memory update turbopack-build-memory --if-revision 3 --status-note 'resolved by the FS cache; the cache is now the bug'",
        explanation:
          "re-leases the status line for 14 days without touching the durable body",
      },
      {
        invocation:
          "cctl memory update ticket90-notepad-roadmap --if-revision 7 --status-note none",
        explanation: "drop a status line that no longer says anything true",
      },
    ],
    related: [
      {
        command: "memory get",
        oneLiner: "read the revision to pass to --if-revision",
      },
      {
        command: "memory mark-reviewed",
        oneLiner: "the note is still right — just re-lease it",
      },
    ],
  },
  {
    path: ["memory", "link"],
    summary: "bind a note to the ticket, spec, session, or lane it concerns",
    description:
      "Bind a note to the ticket, spec, or workflow it is about and it leads the index of every conversation working that artifact — an about link is a relevance cue, and this is the one act that makes a note find its own readers. A source link records provenance and never affects selection or ranking. Links are progressive disclosure, never a freshness mechanism: a note's review lease is what says when to check it again.",
    usage: [
      `cctl memory link ${SLUG_PLACEHOLDER} --artifact <handle> [--kind <about|source>] [--scope <scope>]`,
    ],
    flags: [artifactFlag, linkKindFlag, scopeFlag],
    examples: [
      {
        invocation:
          "cctl memory link ticket90-notepad-roadmap --artifact ticket:74",
        explanation:
          "an about link by the ticket's number in this project, so the note leads the index of any conversation working that ticket",
      },
      {
        invocation:
          "cctl memory link ticket90-notepad-roadmap --artifact ticket:command-center#74",
        explanation:
          "the same link when the ticket is in another project than the one this conversation runs in",
      },
      {
        invocation:
          "cctl memory link ticket90-notepad-roadmap --artifact spec:memory --kind source",
        explanation:
          "record where the lesson came from without letting it cue selection",
      },
    ],
    related: [
      {
        command: "memory unlink",
        oneLiner: "remove a link that no longer holds",
      },
      {
        command: "memory recall",
        oneLiner: "read the notes linked to one artifact",
      },
    ],
  },
  {
    path: ["memory", "unlink"],
    summary: "remove a note's link to an artifact",
    description:
      "Removes the link with this kind and artifact; the note itself is untouched.",
    usage: [
      `cctl memory unlink ${SLUG_PLACEHOLDER} --artifact <handle> [--kind <about|source>] [--scope <scope>]`,
    ],
    flags: [artifactFlag, linkKindFlag, scopeFlag],
    examples: [
      {
        invocation:
          "cctl memory unlink ticket90-notepad-roadmap --artifact ticket:74",
        explanation: "drop the about link once the note outgrew that ticket",
      },
    ],
    related: [
      { command: "memory link", oneLiner: "create the link this removes" },
      { command: "memory get", oneLiner: "see which links a note carries" },
    ],
  },
  {
    path: ["memory", "mark-reviewed"],
    summary: "confirm a note is still true and re-lease it",
    description:
      "Refreshes the note's review lease, which makes the note eligible for ambient delivery again. With --status it refreshes the status line's lease instead, which is what a note delivered without its status line is asking for; it prints the status line you are re-asserting, its age, and the new lease date, so you read the claim before it is eligible to ride the note again. Eligible is not delivered: the line travels only where the note itself does, which its scope, its index mode, and the block's budget decide. A perishable caveat goes in the statusNote, never in the hook, so this act re-leases the caveat alone and leaves the durable note untouched — read the printed claim and reach for 'cctl memory update --status-note' when it is no longer what you would write today.",
    usage: [
      `cctl memory mark-reviewed ${SLUG_PLACEHOLDER} [--status] [--if-revision <n>] [--scope <scope>]`,
    ],
    flags: [
      {
        name: "status",
        kind: "boolean",
        description: "re-lease the status line rather than the whole note",
      },
      ifRevisionFlag,
      scopeFlag,
    ],
    examples: [
      {
        invocation: "cctl memory mark-reviewed shared-state-db --status",
        explanation:
          "the status line is still accurate — restore it to the index for another 14 days",
      },
    ],
    related: [
      { command: "memory review", oneLiner: "find what is due for review" },
      {
        command: "memory update",
        oneLiner: "the note was wrong, not just old",
      },
    ],
  },
  {
    path: ["memory", "promote"],
    summary: "carry a session note up to project scope before the session ends",
    description:
      "Creates a project-scope successor of a session note and archives the session note pointing at it, in one act — both revision histories are preserved. State fields to rewrite the note on the way up. A slug already taken in the project scope is refused naming the holder rather than silently suffixed.",
    usage: [
      `cctl memory promote ${SLUG_PLACEHOLDER} [--slug <new-slug>] [--hook "<line>"] [--body "<markdown>"] [--status-note "<line>"] [--index-mode <mode>] [--if-revision <n>]`,
    ],
    flags: [
      {
        name: "slug",
        kind: "value",
        valuePlaceholder: "<slug>",
        description:
          "the promoted note's project-scope handle (default: the session note's own)",
      },
      hookFlag,
      bodyFlag,
      statusNoteFlag,
      indexModeFlag,
      ifRevisionFlag,
    ],
    examples: [
      {
        invocation:
          "cctl memory promote lane-worktree-resync --hook 'lane worktrees never re-sync: merge the session branch in pre-resume'",
        explanation:
          "keep the lesson and rewrite the hook for readers who were not in this session",
      },
    ],
    related: [
      {
        command: "memory review",
        oneLiner: "list the session notes offered for promotion",
      },
      { command: "memory create", oneLiner: "capture a new note instead" },
    ],
  },
  {
    path: ["memory", "review"],
    summary: "list the notes that have gone stale or await promotion",
    description:
      "The pre-computed maintenance queue: notes past their review lease, notes past their status line's lease, expired notes, and the durable session notes of a completed session that are offered for promotion. Each row says why it is queued and names the command that clears it.",
    usage: [
      "cctl memory review [--promotable] [--project-candidates] [--limit <n>]",
    ],
    flags: [
      {
        name: "project-candidates",
        kind: "boolean",
        description:
          "durable promotion candidates from every completed session in the caller’s project; ordinary delivery visibility is unchanged",
      },
      {
        name: "promotable",
        kind: "boolean",
        description:
          "only the session notes of a completed session offered for promotion",
      },
      {
        name: "limit",
        kind: "value",
        valuePlaceholder: "<n>",
        description: "rows to print (default: 20)",
      },
    ],
    examples: [
      {
        invocation: "cctl memory review",
        explanation: "everything asking for attention, most stale first",
      },
      {
        invocation: "cctl memory review --promotable",
        explanation:
          "what would be lost when this session's scope goes away, so promote it first",
      },
    ],
    related: [
      {
        command: "memory mark-reviewed",
        oneLiner: "clear a row that is still true",
      },
      {
        command: "memory promote",
        oneLiner: "carry a session note up a scope",
      },
    ],
  },
  {
    path: ["memory", "observe-rederivation"],
    summary: "record that a round re-derived what a note already held",
    description:
      "An observation about a validation round, not an edit of the note: it says a round spent itself re-deriving a fact one of its notes already stated. Recording is what memory delivery is measured by — the counters decide whether validators should keep receiving notes at all — and the observation is accepted from callers whose note contributions are refused, because the validator whose rounds it counts is exactly one of them. Nothing is read back: no caller can learn how often a note has been retrieved.",
    usage: [
      `cctl memory observe-rederivation ${SLUG_PLACEHOLDER} [--artifact <handle>] [--scope <scope>]`,
    ],
    flags: [
      {
        name: "artifact",
        kind: "value",
        valuePlaceholder: "<handle>",
        description:
          "the round this happened in: context:<executionId>/<contextId> or execution:<id>",
      },
      scopeFlag,
    ],
    examples: [
      {
        invocation:
          "cctl memory observe-rederivation lane-branches-dont-inherit-session-fixes --artifact context:8c0e6e28/validate-lane",
        explanation:
          "this round re-established something the note it was given already said",
      },
    ],
    related: [
      {
        command: "memory recall",
        oneLiner: "read the note the round should have used",
      },
      {
        command: "memory link",
        oneLiner: "link the note to the artifact so the next round is given it",
      },
    ],
  },
  {
    path: ["memory", "archive"],
    summary: "retire a note without destroying it",
    description:
      "The ordinary removal: the note leaves every index and search default on the next build, stays fetchable with --archived, and can be restored from the Memory Library. Reach for this rather than delete — a wrong note is evidence about what was believed.",
    usage: [
      `cctl memory archive ${SLUG_PLACEHOLDER} [--if-revision <n>] [--scope <scope>]`,
    ],
    flags: [ifRevisionFlag, scopeFlag],
    examples: [
      {
        invocation: "cctl memory archive ticket70-stale-build",
        explanation:
          "the lesson stopped applying; it stays readable, just not delivered",
      },
    ],
    related: [
      { command: "memory delete", oneLiner: "destroy it permanently instead" },
      {
        command: "memory list",
        oneLiner: "list archived notes with --archived",
      },
    ],
  },
  {
    path: ["memory", "delete"],
    summary: "permanently destroy a note and its whole history",
    description:
      "Irreversible: the note, every revision of it, and its links are gone. --confirm is required and there is no other spelling, because archive is the removal you almost always want. Prefer 'cctl memory archive' unless the content must not exist.",
    usage: [
      `cctl memory delete ${SLUG_PLACEHOLDER} --confirm [--scope <scope>]`,
    ],
    flags: [
      {
        name: "confirm",
        kind: "boolean",
        description:
          "required — acknowledges that this destroys the note and its history",
      },
      scopeFlag,
    ],
    examples: [
      {
        invocation: "cctl memory delete leaked-credential-note --confirm",
        explanation:
          "the one case delete is right: content that must not remain in the store at all",
      },
    ],
    related: [
      {
        command: "memory archive",
        oneLiner: "the reversible removal to prefer",
      },
    ],
  },
  {
    path: ["memory", "export"],
    summary: "write every visible note to a portable markdown archive",
    description:
      "Writes a frontmatter-markdown archive of the notes this conversation can see, archived and proposed records included, at current-state full fidelity: hook, body, status line, slug, aliases, kind, scope, index mode, lifecycle, review lease, expiry, links, and supersession pointer. Revision history is excluded by design and stays in the database.",
    usage: ["cctl memory export --output <path> [--scope <scope>]"],
    flags: [
      {
        name: "output",
        kind: "value",
        valuePlaceholder: "<path>",
        description: "where to write the archive",
      },
      scopeFlag,
    ],
    examples: [
      {
        invocation: "cctl memory export --output .cc/temp/memory-archive.md",
        explanation:
          "the whole visible library as one portable document, readable without Command Center",
      },
    ],
    related: [
      { command: "memory list", oneLiner: "see what the archive will contain" },
    ],
  },
];
