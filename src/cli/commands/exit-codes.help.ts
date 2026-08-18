import { exitTaxonomyLines } from "../exit-taxonomy";
import type { CommandHelpEntry } from "../help-types";

/**
 * Help for `cctl exit-codes`. The body is rendered from `EXIT_TAXONOMY`, not
 * restated: help is the recovery path an agent reaches for after a non-zero
 * exit, and a prose copy of the table is a copy that can disagree with the
 * binary that produced the code.
 */
export const exitCodesHelpEntries: CommandHelpEntry[] = [
  {
    path: ["exit-codes"],
    summary: "what each cctl exit code means and how to recover from it",
    description:
      "Print the exit taxonomy every cctl command shares. Needs no server and no identity, so it answers the question the failing command just raised. Terminal: no hint.",
    usage: ["cctl exit-codes [--json]"],
    flags: [],
    examples: [
      {
        invocation: "cctl exit-codes",
        explanation:
          "read what the code a command just exited with asserts, and which command resolves it",
      },
    ],
    generatedReference: [{ title: "exit codes", lines: exitTaxonomyLines() }],
    related: [
      {
        command: "doctor",
        oneLiner: "the exit-3 and exit-4 diagnosis (connectivity, auth, build)",
      },
      { command: "version", oneLiner: "print just the cctl build stamp" },
    ],
  },
];
