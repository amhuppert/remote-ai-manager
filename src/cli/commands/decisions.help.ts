import type { CommandHelpEntry } from "../help-types";

/**
 * Help-registry entries for `cctl decisions` (docs/design/cc-cli/04 §2.2/§2.4):
 * the group hub plus the `propose` leaf. Ported from the legacy `help.ts` block
 * and the cc-cli SKILL.md; `decisions propose` reads only `--file`
 * (`decisions.ts`).
 */
export const decisionsHelpEntries: CommandHelpEntry[] = [
  {
    path: ["decisions"],
    summary: "propose decisions for the user's review",
    description:
      "Propose one or more decisions for the user to review. The review is asynchronous: end the proposing turn, then the complete decision review result returns as the next user message.",
    usage: ["cctl decisions propose --file .cc/temp/decisions.json"],
    flags: [],
    examples: [],
    related: [
      {
        command: "charter write",
        oneLiner:
          "submit a whole Alignment charter instead of discrete decisions",
      },
    ],
  },
  {
    path: ["decisions", "propose"],
    summary: "propose a decision batch for review",
    description:
      "Persist a batch of decisions for the user's review, write a brief handoff note, and end the turn. File-only: author .cc/temp/decisions.json (git-ignored scratch) as a JSON object with a non-empty `decisions` array. Approve/reject stays human-driven; one complete result covering every decision and any rejection feedback arrives as the next user message. Attended-only: exits 1 on an autonomous turn.",
    usage: ["cctl decisions propose --file .cc/temp/decisions.json"],
    flags: [
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<decisions.json>",
        description:
          'JSON object { "decisions": [{ "statement", "rationale"?, "context"? }] }',
      },
    ],
    examples: [
      {
        invocation: "cctl decisions propose --file .cc/temp/decisions.json",
        explanation:
          'the payload is { "decisions": [{ "statement": "…", "rationale"?: "…", "context"?: "…" }] } — each statement is one decision',
      },
    ],
    related: [
      {
        command: "charter write",
        oneLiner: "submit the whole charter when the change is broad",
      },
    ],
  },
];
