import type { CommandHelpEntry } from "../help-types";

/**
 * Help-registry entries for `cctl docs` (docs/design/cc-cli/04 §2.2): the group
 * hub plus the register/list/delete leaves.
 */
export const docsHelpEntries: CommandHelpEntry[] = [
  {
    path: ["docs"],
    summary: "register, list, and delete reference documents",
    description:
      "Manage this session's reference documents — files other conversations see in their system prompt, with a note on when to read them.",
    usage: ["cctl docs <register|list|delete>"],
    flags: [],
    examples: [],
    related: [],
  },
  {
    path: ["docs", "register"],
    summary: "register (or update) a reference document",
    description:
      "Register or update a document by path — idempotent on the path (re-registering updates the description in place). The path must resolve inside the session worktree; an escaping path exits 2. Terminal: no hint.",
    usage: ['cctl docs register <path> --description "<why it matters>"'],
    flags: [
      {
        name: "description",
        kind: "value",
        valuePlaceholder: '"<why it matters>"',
        description: "required — when and why agents should read the document",
      },
    ],
    examples: [
      {
        invocation:
          'cctl docs register docs/api-contract.md --description "read before touching any /api route"',
        explanation:
          "registers the doc; re-running with the same path updates its description in place",
      },
    ],
    related: [
      {
        command: "docs list",
        oneLiner: "see every registered document and its id",
      },
      { command: "docs delete", oneLiner: "deregister a document by id" },
    ],
  },
  {
    path: ["docs", "list"],
    summary: "list registered reference documents",
    description:
      "Print every registered document as `id  path  —  description`. With --json the documents are in the `documents` array and the hint is in the reserved `hint` field.",
    usage: ["cctl docs list [--json]"],
    flags: [],
    examples: [
      {
        invocation: "cctl docs list",
        explanation: "copy an id from the output to pass to `cctl docs delete`",
      },
    ],
    related: [
      { command: "docs register", oneLiner: "register a new document" },
      { command: "docs delete", oneLiner: "deregister a document by id" },
    ],
  },
  {
    path: ["docs", "delete"],
    summary: "deregister a reference document",
    description:
      "Deregister by <id> (from `docs list`) and remove the file from disk. An unknown id exits 2. Terminal: no hint.",
    usage: ["cctl docs delete <id>"],
    flags: [],
    examples: [
      {
        invocation: "cctl docs delete 4f1d2797-...",
        explanation: "the <id> is the first column of `cctl docs list` output",
      },
    ],
    related: [
      { command: "docs list", oneLiner: "find the id to delete" },
      { command: "docs register", oneLiner: "register a new document" },
    ],
  },
];
