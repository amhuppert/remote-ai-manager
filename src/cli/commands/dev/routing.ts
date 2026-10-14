import {
  encodePathSegment,
  type CliEnv,
  type SessionContext,
} from "../../transport";

export type DevCommandTarget = { kind: "session" };

export type DevCommandTargetInference =
  | { ok: true; target: DevCommandTarget }
  | { ok: false; message: string };

export function inferDevCommandTarget(
  flags: { readonly project?: string; readonly session?: string },
  _env: CliEnv,
): DevCommandTargetInference {
  if (flags.project !== undefined || flags.session !== undefined) {
    return { ok: true, target: { kind: "session" } };
  }
  return { ok: true, target: { kind: "session" } };
}

/** A dev server that is up and can be addressed — a second CC instance. */
export interface DevInstance {
  serverName: string;
  url: string;
  /** The worktree it serves, whose `.config` holds its state and token. */
  worktreePath: string | null;
}

export function devServerRequestPath(
  context: SessionContext,
  _target: DevCommandTarget,
  suffix = "",
): string {
  const path = `/api/projects/${encodePathSegment(context.project)}/sessions/${encodePathSegment(context.session)}/dev-servers${suffix}`;
  return path;
}
