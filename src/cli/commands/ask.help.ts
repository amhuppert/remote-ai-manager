import type { CommandHelpEntry } from "../help-types";

/**
 * Help-registry entry for `cctl ask` (docs/design/cc-cli/04 §2.2/§2.4). Single
 * leaf node — `ask` takes no positionals and has no subcommands. Ported from the
 * legacy `help.ts` block and the cc-cli SKILL.md; flags match `ask.ts`'s
 * `checkFlags` (file, question, option, header, context, multi-select).
 */
export const askHelpEntries: CommandHelpEntry[] = [
  {
    path: ["ask"],
    summary: "ask the user a question batch, then end your turn",
    description:
      "Register a multiple-choice question batch on this conversation, then END YOUR TURN — the question is registered, not awaited; the answer arrives as your NEXT user message. Ask only at real forks (consequential, hard-to-reverse, or genuinely ambiguous); batch related questions into one call. Takes no positional arguments.",
    usage: [
      "cctl ask --file .cc/temp/questions.json",
      'cctl ask --question "<text>" --option <label> --option <label> [--multi-select] [--header "<h>"] [--context "<c>"]',
    ],
    flags: [
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<questions.json>",
        description:
          'batch form — a JSON object {"questions":[…]} authored with the Write tool under .cc/temp/ (git-ignored scratch)',
      },
      {
        name: "question",
        kind: "value",
        valuePlaceholder: '"<text>"',
        description: "single-question sugar — the question prompt",
      },
      {
        name: "option",
        kind: "value",
        valuePlaceholder: "<label>",
        description: "a choice for --question; repeat once per option (≥ 1)",
        repeatable: true,
      },
      {
        name: "header",
        kind: "value",
        valuePlaceholder: '"<h>"',
        description: "single-question form: the panel header",
      },
      {
        name: "context",
        kind: "value",
        valuePlaceholder: '"<c>"',
        description: "single-question form: the implications note",
      },
      {
        name: "multi-select",
        kind: "boolean",
        description: "single-question form: allow selecting several options",
      },
    ],
    examples: [
      {
        invocation:
          'cctl ask --question "Which migration order?" --option "Phases in order" --option "Fast path"',
        explanation:
          "inline sugar — repeat --option per choice (≥ 1); after it succeeds, write a brief handoff note and END YOUR TURN",
      },
      {
        invocation: "cctl ask --file .cc/temp/questions.json",
        explanation:
          'batch form — the payload is {"questions":[{"question":"…","options":[{"label":"…"}],"multiSelect"?,"header"?,"context"?}]}',
      },
    ],
    domainContext:
      "With --json the envelope is { ok, questionBatchId, instruction } — `instruction` is a dedicated load-bearing field, never a `hint`. In an autonomous conversation (or a lane with asking disabled) it exits 1 'proceed with best judgment' — decide yourself and record the rationale.",
    related: [
      {
        command: "notify",
        oneLiner:
          "one-way push (no answer expected) — use when you are not asking a question",
      },
    ],
  },
];
