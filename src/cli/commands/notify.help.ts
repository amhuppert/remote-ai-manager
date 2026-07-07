import type { CommandHelpEntry } from "../help-types";

/**
 * Help-registry entry for `cctl notify` (docs/design/cc-cli/04 §2.2/§2.4). Single
 * leaf node — the message is a positional and `--title` is the only extra flag
 * (`notify.ts` `checkFlags`). Ported from the legacy `help.ts` block and the
 * cc-cli SKILL.md.
 */
export const notifyHelpEntries: CommandHelpEntry[] = [
  {
    path: ["notify"],
    summary: "send a push notification to the user",
    description:
      "Send a push notification to the user (a long task finished, you need attention). The message is the single positional — quote multi-word messages. Terminal: no hint. When push is unconfigured the endpoint returns 409 and the command exits 1 with the reason — treat that as non-fatal.",
    usage: ['cctl notify "<message>" [--title "<title>"]'],
    flags: [
      {
        name: "title",
        kind: "value",
        valuePlaceholder: '"<title>"',
        description: "notification title; a generic title is used when omitted",
      },
    ],
    examples: [
      {
        invocation: 'cctl notify "Build finished — 0 failures" --title "CI"',
        explanation:
          "quote multi-word messages; exit 1 here is non-fatal (push just unconfigured)",
      },
    ],
    related: [
      {
        command: "ask",
        oneLiner:
          "ask a question and end your turn when you need an answer back",
      },
    ],
  },
];
