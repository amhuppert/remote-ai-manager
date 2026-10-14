import { encodePathSegment, type SessionContext } from "../../transport";

/** A dev server that is up and can be addressed — a second CC instance. */
export interface DevInstance {
  serverName: string;
  url: string;
  /** The worktree it serves, whose `.config` holds its state and token. */
  worktreePath: string | null;
}

export function devServerRequestPath(
  context: SessionContext,
  suffix = "",
): string {
  return `/api/projects/${encodePathSegment(context.project)}/sessions/${encodePathSegment(context.session)}/dev-servers${suffix}`;
}
