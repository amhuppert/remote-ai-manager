/**
 * The exit taxonomy as data (docs/design/cc-cli/09 §4). Help, the `exit-codes`
 * command, the cc-cli SKILL.md table, and `shared.ts`'s failures all answer the
 * same question — what does exit N mean and what does the caller do about it —
 * and a prose copy per surface is a copy that can disagree with the binary.
 *
 * It sits BELOW `shared.ts` in the import graph (it imports nothing) so a
 * `*.help.ts` entry can derive its rendered body from the table without cycling
 * back through `shared.ts` → `help-registry.ts` → `*.help.ts`.
 */

// Exit codes per docs/design/cc-cli/01 §6.
export const EXIT_OK = 0;
export const EXIT_OPERATION_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_CONNECTION = 3;
export const EXIT_VERSION_MISMATCH = 4;

export interface ExitCodeMeaning {
  readonly code: number;
  /** What the exit code asserts about what happened. */
  readonly meaning: string;
  /** The command that resolves it, or null when the code needs none. */
  readonly recovery: string | null;
}

export const EXIT_TAXONOMY: readonly ExitCodeMeaning[] = [
  {
    code: EXIT_OK,
    meaning: "the command did what was asked",
    recovery: null,
  },
  {
    code: EXIT_OPERATION_FAILED,
    meaning:
      "the server refused the operation, or a server-side job it started failed",
    recovery: null,
  },
  {
    code: EXIT_USAGE,
    meaning:
      "a local flag, identity, or payload check failed before any request was sent",
    recovery: "cctl <command> --help",
  },
  {
    code: EXIT_CONNECTION,
    meaning: "the CC server could not be reached, or it rejected the API token",
    recovery: "cctl doctor",
  },
  {
    code: EXIT_VERSION_MISMATCH,
    meaning:
      "this binary and the server are different builds — nothing changed unless the failure text warns the mutation may have committed",
    recovery: "cctl doctor --server <url>",
  },
];

/**
 * One text line per exit code, for the surfaces an agent reads directly (the
 * `exit-codes` command body and its help node's reference block). The markdown
 * table in the cc-cli SKILL.md is rendered by its generator from the same rows.
 */
export function exitTaxonomyLines(
  taxonomy: readonly ExitCodeMeaning[] = EXIT_TAXONOMY,
): string[] {
  return taxonomy.map((row) =>
    row.recovery === null
      ? `${row.code}  ${row.meaning}`
      : `${row.code}  ${row.meaning} — run: ${row.recovery}`,
  );
}
