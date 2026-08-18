import { EXIT_OK, EXIT_TAXONOMY, exitTaxonomyLines } from "../exit-taxonomy";
import {
  checkFlags,
  render,
  type CliResult,
  type GlobalFlags,
} from "../shared";

/**
 * `cctl exit-codes` — the exit taxonomy an agent needs exactly when a command
 * has already failed. It contacts nothing and resolves no identity, so it stays
 * answerable when the failure was the connection itself.
 */
export function runExitCodes(
  flags: GlobalFlags,
  values: Record<string, string>,
): CliResult {
  const json = flags.json;
  const denied = checkFlags(values, "exit-codes", json);
  if (denied) return denied;

  return {
    exitCode: EXIT_OK,
    stdout: render(json, `${exitTaxonomyLines().join("\n")}\n`, {
      ok: true,
      exitCodes: EXIT_TAXONOMY,
    }),
    stderr: "",
  };
}
