import type { CommandHelpEntry } from "../help-types";

/**
 * Help-registry entries for `cctl charter` (docs/design/cc-cli/04 §2.2/§2.4):
 * the group hub plus the `write` leaf. Ported from the legacy `help.ts` block and
 * the cc-cli SKILL.md; `charter write` reads only `--file` (`charter.ts`).
 */
export const charterHelpEntries: CommandHelpEntry[] = [
  {
    path: ["charter"],
    summary: "submit the session's Alignment charter",
    description:
      "Submit the session's Alignment charter — the free-text markdown document that governs the whole session. A normal /align draft waits for approval; a draft that incorporates already-approved decisions activates immediately.",
    usage: ["cctl charter write --file .cc/temp/charter.json"],
    flags: [],
    examples: [],
    related: [
      {
        command: "decisions propose",
        oneLiner: "propose discrete decisions that fold into the charter",
      },
    ],
  },
  {
    path: ["charter", "write"],
    summary: "submit the Alignment charter draft",
    description:
      'Fill the session\'s open charter draft. File-only: author .cc/temp/charter.json (git-ignored scratch) as a JSON object { "content": "<full markdown>" } with the Write tool. A /align draft enters the Approve-Charter panel and leaves the active charter unchanged; a draft opened by decision approval activates immediately because the decision review was its human gate. The command reports which outcome occurred. Attended-only: exits 1 on an autonomous turn or with no live conversation.',
    usage: ["cctl charter write --file .cc/temp/charter.json"],
    flags: [
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<charter.json>",
        description:
          'JSON object { "content": "<full markdown>" } — the charter body',
      },
    ],
    examples: [
      {
        invocation: "cctl charter write --file .cc/temp/charter.json",
        explanation:
          'the payload is { "content": "<full markdown>" }; reports either a draft pending approval or the activated decision-incorporation version',
      },
    ],
    related: [
      {
        command: "decisions propose",
        oneLiner: "propose discrete decisions instead of a whole charter",
      },
    ],
  },
];
