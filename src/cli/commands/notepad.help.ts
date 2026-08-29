import type { CommandHelpEntry } from "../help-types";

/**
 * Help-registry entries for `cctl notepad` — the group hub, the five content
 * verbs (notepad design D6), and the two review-comment verbs under the
 * `comment` subgroup (D16). Flags match what `notepad.ts` actually reads.
 *
 * Every leaf that addresses a notepad takes its immutable id, never its name: a
 * name is a display value the user can change at any time, while the id printed
 * in a list row, carried by a chip's reference XML, and stamped on an injected
 * notepad block resolves to the same notepad forever. A comment is addressed
 * through its notepad for the same reason it is stored that way — it quotes one
 * notepad's text and is reachable nowhere else.
 */

const ID_PLACEHOLDER = "<notepadId>";
const COMMENT_ID_PLACEHOLDER = "<commentId>";

const contentFlag = {
  name: "content",
  kind: "value" as const,
  valuePlaceholder: '"<markdown>"',
  fileSource: true as const,
  description:
    "canonical Markdown text — reference XML and [Image: <id>] tokens are content, not markup to strip",
};

const ifRevisionFlag = {
  name: "if-revision",
  kind: "value" as const,
  valuePlaceholder: "<n>",
  description:
    "required — the revision this write is based on, from the read that produced it",
};

const globalFlag = {
  name: "global",
  kind: "boolean" as const,
  description: "the global scope instead of the ambient project's",
};

export const notepadHelpEntries: CommandHelpEntry[] = [
  {
    path: ["notepad"],
    summary: "list, read, create, update, and append to notepads",
    description:
      "Read and write Command Center notepads — durable Markdown documents the user and agents share, scoped either globally or to one project. The comment subgroup reads the review comments the user left on a notepad's passages.",
    usage: ["cctl notepad <list|get|create|update|append|comment>"],
    flags: [],
    examples: [],
    domainContext:
      "A notepad is addressed by its immutable id; the name is a display value that can change under you.\nContent is Markdown text carrying Command Center references in their XML form (each with its own read command) and images as [Image: <id>] tokens.\nWrite modes (read-only / append-only / full-edit) are the user's control over agent writes, so a refused write names the mode and stays refused until the user widens it.\nRename, pin, archive, delete, and write-mode changes are user acts in the notepad panel — there are no agent verbs for them.",
    related: [
      {
        command: "notepad list",
        oneLiner: "find the id of a notepad to read or write",
      },
      { command: "notepad get", oneLiner: "read a notepad's full content" },
      {
        command: "notepad comment",
        oneLiner: "read and answer the user's review comments",
      },
    ],
  },
  {
    path: ["notepad", "list"],
    summary: "list notepads in scope with their ids and revisions",
    description:
      "List the global notepads merged with the ambient project's, or only the global ones with --global. Archived notepads are hidden unless --archived asks for them. One row per notepad, capped at 20 — the leading count line names the exact command that reveals the rest.",
    usage: ["cctl notepad list [--global] [--archived] [--limit <n>]"],
    flags: [
      globalFlag,
      {
        name: "archived",
        kind: "boolean",
        description: "include archived notepads (hidden by default)",
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
        invocation: "cctl notepad list",
        explanation:
          "global notepads plus the ambient project's, most recently updated first",
      },
      {
        invocation: "cctl notepad list --global --archived",
        explanation:
          "only the global scope, including notepads the user has archived",
      },
    ],
    related: [
      { command: "notepad get", oneLiner: "read one row's notepad in full" },
      { command: "notepad create", oneLiner: "create a new notepad" },
    ],
  },
  {
    path: ["notepad", "get"],
    summary: "read a notepad's canonical content by id",
    description:
      "Print a notepad's metadata and its full canonical Markdown, with embedded references in their XML form — each carries the command that retrieves what it points at. The revision this prints is the one a following update or append passes to --if-revision. Content past the stdout budget is written under .cc/temp/ and stdout carries the artifact manifest instead of truncating.",
    usage: [`cctl notepad get ${ID_PLACEHOLDER}`],
    flags: [],
    examples: [
      {
        invocation: "cctl notepad get 6f1c2b7e-2f5a-4a1e-9a0b-3d2c8f4e5a6b",
        explanation:
          "the id comes from a list row, a notepad chip's XML, or an injected notepad block",
      },
    ],
    related: [
      { command: "notepad list", oneLiner: "find the id to read" },
      {
        command: "notepad update",
        oneLiner: "replace the content you just read",
      },
      {
        command: "notepad append",
        oneLiner: "add to the content you just read",
      },
      {
        command: "notepad comment list",
        oneLiner: "see what the user asked about this content",
      },
    ],
  },
  {
    path: ["notepad", "create"],
    summary: "create a notepad in the ambient project or the global scope",
    description:
      "Create a notepad and print its new id. Scope is the ambient project unless --global is passed; names are unique within a scope, so a duplicate name is refused naming the notepad that already holds it. New notepads accept agent writes (full-edit) until the user narrows the mode.",
    usage: [
      'cctl notepad create --name "<name>" [--global] [--content "<markdown>"]',
    ],
    flags: [
      {
        name: "name",
        kind: "value",
        valuePlaceholder: '"<name>"',
        description: "required — display name, unique within the scope",
      },
      globalFlag,
      contentFlag,
    ],
    examples: [
      {
        invocation:
          'cctl notepad create --name "Migration notes" --content "## Checklist"',
        explanation:
          "creates it in the ambient project and prints the id to write to next",
      },
      {
        invocation:
          'cctl notepad create --name "Standing context" --global --content-file .cc/temp/notepad.md',
        explanation:
          "author the body in a file when it carries backticks, quotes, or newlines",
      },
    ],
    related: [
      {
        command: "notepad list",
        oneLiner: "confirm the new notepad is listed",
      },
      { command: "notepad append", oneLiner: "add to it after creating it" },
    ],
  },
  {
    path: ["notepad", "update"],
    summary: "replace a notepad's content, stating the revision you read",
    description:
      "Replace the whole content of a notepad. --if-revision is required and must be the revision the content was read at: if another writer has moved the notepad on, the write is refused reporting the current revision, and re-reading before retrying is what keeps their content from being discarded. Refused on a read-only or append-only notepad, naming the mode.",
    usage: [
      `cctl notepad update ${ID_PLACEHOLDER} --if-revision <n> --content "<markdown>"`,
    ],
    flags: [ifRevisionFlag, contentFlag],
    examples: [
      {
        invocation:
          "cctl notepad update 6f1c2b7e-2f5a-4a1e-9a0b-3d2c8f4e5a6b --if-revision 4 --content-file .cc/temp/notepad.md",
        explanation:
          "replaces the content when the notepad is still at revision 4",
      },
    ],
    related: [
      {
        command: "notepad get",
        oneLiner: "read the current revision before writing",
      },
      { command: "notepad append", oneLiner: "add without replacing" },
      {
        command: "notepad comment reply",
        oneLiner: "say how the change answers the comment that asked for it",
      },
    ],
  },
  {
    path: ["notepad", "append"],
    summary: "append to a notepad, stating the revision you read",
    description:
      "Append text to the end of a notepad, separated from the existing content by a blank line. --if-revision is required and carries the same compare-and-swap contract as update. Accepted on an append-only notepad; refused on a read-only one, naming the mode.",
    usage: [
      `cctl notepad append ${ID_PLACEHOLDER} --if-revision <n> --content "<markdown>"`,
    ],
    flags: [ifRevisionFlag, contentFlag],
    examples: [
      {
        invocation:
          'cctl notepad append 6f1c2b7e-2f5a-4a1e-9a0b-3d2c8f4e5a6b --if-revision 4 --content "## Findings — the gate fails on the vitest step."',
        explanation:
          "adds a section without re-sending content the notepad already has",
      },
    ],
    related: [
      {
        command: "notepad get",
        oneLiner: "read the current revision before writing",
      },
      { command: "notepad update", oneLiner: "replace the content instead" },
    ],
  },
  {
    path: ["notepad", "comment"],
    summary: "read the user's review comments on a notepad and answer them",
    description:
      "Two verbs, and deliberately only two: read the comments the user anchored to passages of a notepad, and reply to one. Deciding a comment is settled — resolving, reopening, or deleting it — is the user's judgement about whether the response addressed it, so it has no agent verb here and is refused if attempted through the API.",
    usage: [`cctl notepad comment <list|reply> ${ID_PLACEHOLDER}`],
    flags: [],
    examples: [],
    domainContext:
      "A comment quotes one passage of the notepad's canonical text and names where it sits, so the quote can be found verbatim in what 'cctl notepad get' returns.\nA stale comment is one whose quoted passage no longer matches the current content; it is never moved onto different text, so re-read the notepad to see what changed under it.\nAnswering a comment is a reply and is accepted whatever the notepad's write mode says — a reply is review discussion, not a content change. Changing the content the comment asks about is an ordinary update or append under that mode.",
    related: [
      {
        command: "notepad get",
        oneLiner: "read the content the comments quote",
      },
      {
        command: "notepad comment list",
        oneLiner: "see which comments are open",
      },
    ],
  },
  {
    path: ["notepad", "comment", "list"],
    summary: "list a notepad's comments with their quoted passages",
    description:
      "One block per comment: its id, status, whether its quoted passage still resolves in the current content, where it sits, the quote, the body, and any replies. Quote and location are stated over the canonical text 'notepad get' returns. Capped at 20 comments — the leading count line names the exact command that reveals the rest — and output past the stdout budget is written under .cc/temp/ with the manifest on stdout instead of truncating.",
    usage: [
      `cctl notepad comment list ${ID_PLACEHOLDER} [--status <open|resolved>] [--limit <n>]`,
    ],
    flags: [
      {
        name: "status",
        kind: "value",
        valuePlaceholder: "<open|resolved>",
        description: "narrow to one status (default: every comment)",
      },
      {
        name: "limit",
        kind: "value",
        valuePlaceholder: "<n>",
        description: "comments to print (default: 20)",
      },
    ],
    examples: [
      {
        invocation:
          "cctl notepad comment list 6f1c2b7e-2f5a-4a1e-9a0b-3d2c8f4e5a6b --status open",
        explanation: "the comments still awaiting an answer, oldest first",
      },
    ],
    related: [
      {
        command: "notepad comment reply",
        oneLiner: "answer one of the comments listed",
      },
      {
        command: "notepad get",
        oneLiner: "read the passage a comment quotes in context",
      },
    ],
  },
  {
    path: ["notepad", "comment", "reply"],
    summary: "reply to one comment on a notepad",
    description:
      "Add a reply to a comment, attributed to the calling conversation. Accepted whatever the notepad's write mode is, because a reply is review discussion rather than a content change. Replying does not settle the comment: the user decides that, and there is no agent verb for it.",
    usage: [
      `cctl notepad comment reply ${ID_PLACEHOLDER} ${COMMENT_ID_PLACEHOLDER} --body "<markdown>"`,
    ],
    flags: [
      {
        name: "body",
        kind: "value",
        valuePlaceholder: '"<markdown>"',
        fileSource: true,
        description:
          "required — the reply text, Markdown, addressed to what the comment asked",
      },
    ],
    examples: [
      {
        invocation:
          'cctl notepad comment reply 6f1c2b7e-2f5a-4a1e-9a0b-3d2c8f4e5a6b cmt-3f9a --body "Rewrote that paragraph in revision 5."',
        explanation:
          "both ids come from a 'notepad comment list' block on that notepad",
      },
    ],
    related: [
      {
        command: "notepad comment list",
        oneLiner: "find the comment id to answer",
      },
      {
        command: "notepad update",
        oneLiner: "change the content the comment asks about",
      },
    ],
  },
];
