import {
  encodePathSegment,
  type CliEnv,
  type SessionContext,
} from "../../transport";

export type DevCommandTarget =
  | { kind: "session" }
  | {
      kind: "workflow-context";
      executionId: string;
      contextId: string;
    };

export type DevCommandTargetInference =
  | { ok: true; target: DevCommandTarget }
  | { ok: false; message: string };

export function inferDevCommandTarget(
  flags: { readonly project?: string; readonly session?: string },
  env: CliEnv,
): DevCommandTargetInference {
  if (flags.project !== undefined || flags.session !== undefined) {
    return { ok: true, target: { kind: "session" } };
  }

  const executionId = env["CC_WORKFLOW_EXECUTION_ID"];
  const contextId = env["CC_WORKFLOW_CONTEXT_ID"];
  if (executionId === undefined && contextId === undefined) {
    return { ok: true, target: { kind: "session" } };
  }
  if (executionId === undefined) {
    return {
      ok: false,
      message:
        "workflow identity is incomplete — CC_WORKFLOW_EXECUTION_ID must be set with CC_WORKFLOW_CONTEXT_ID",
    };
  }
  if (contextId === undefined) {
    return {
      ok: false,
      message:
        "workflow identity is incomplete — CC_WORKFLOW_CONTEXT_ID must be set with CC_WORKFLOW_EXECUTION_ID",
    };
  }
  if (executionId.trim() === "" || contextId.trim() === "") {
    return {
      ok: false,
      message:
        "workflow identity is incomplete — CC_WORKFLOW_EXECUTION_ID and CC_WORKFLOW_CONTEXT_ID must both be non-empty",
    };
  }

  return {
    ok: true,
    target: {
      kind: "workflow-context",
      executionId,
      contextId,
    },
  };
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
  target: DevCommandTarget,
  suffix = "",
): string {
  const path = `/api/projects/${encodePathSegment(context.project)}/sessions/${encodePathSegment(context.session)}/dev-servers${suffix}`;
  if (target.kind === "session") return path;

  const query = new URLSearchParams({
    executionId: target.executionId,
    contextId: target.contextId,
  });
  return `${path}?${query.toString()}`;
}
