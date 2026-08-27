import type { CommandHelpEntry } from "../help-types";

/**
 * Help-registry entries for `cctl notepad` — the group hub plus the five agent
 * verbs (notepad design D6). Flags match what `notepad.ts` actually reads.
 *
 * Every leaf that addresses a notepad takes its immutable id, never its name: a
 * name is a display value the user can change at any time, while the id printed
 * in a list row, carried by a chip's reference XML, and stamped on an injected
 * notepad block resolves to the same notepad forever.
 */

const ID_PLACEHOLDER = "<notepadId>";

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
      "Read and write Command Center notepads — durable Markdown documents the user and agents share, scoped either globally or to one project.",
    usage: ["cctl notepad <list|get|create|update|append>"],
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
];
