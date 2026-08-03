/**
 * Build parity between a `cctl` binary and the server it is talking to.
 *
 * Each CC server publishes its own stamped `cctl` to `<configDir>/bin/cctl`
 * (see `install-cli.ts`), so a binary and a server that disagree on the stamp
 * are two different builds. That is normal to hit while testing a worktree —
 * the binary on PATH belongs to whichever server installed it, and pointing it
 * at a second server with `--server` crosses the boundary. The header these
 * helpers carry is what lets the CLI say so instead of running a stale
 * surface against fresh state.
 *
 * Kept dependency-free so both the Next middleware (edge runtime) and the
 * Node-side gateway handlers can use one comparison.
 */

export const CLI_BUILD_HEADER = "x-cc-cli-build";
export const BUILD_MISMATCH_HEADER = "x-cc-build-mismatch";

export interface BuildMismatch {
  serverBuild: string;
  cliBuild: string;
}

/**
 * The mismatch header value for this request, or null when there is nothing to
 * report. A caller that states no build is not a cctl invocation (a browser,
 * curl, an internal fetch) and is never reported.
 */
export function buildMismatchHeaderValue(
  cliBuild: string | null,
  serverBuild: string,
): string | null {
  if (cliBuild === null || cliBuild === serverBuild) return null;
  return `server=${serverBuild} cli=${cliBuild}`;
}

/** Read back a value produced by {@link buildMismatchHeaderValue}. */
export function parseBuildMismatchHeader(value: string): BuildMismatch | null {
  const match = /^server=(\S+) cli=(\S+)$/.exec(value.trim());
  if (match === null) return null;
  const [, serverBuild, cliBuild] = match;
  if (serverBuild === undefined || cliBuild === undefined) return null;
  return { serverBuild, cliBuild };
}
