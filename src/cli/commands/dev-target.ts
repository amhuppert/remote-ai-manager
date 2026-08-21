import { devServersStatusResponseSchema } from "@/lib/dev-server/schemas";
import {
  EXIT_OPERATION_FAILED,
  cliRequest,
  encodePathSegment,
  failure,
  failureFromRequest,
  usageFailure,
} from "../shared";
import type {
  CliEnv,
  CliHost,
  CliResult,
  GlobalFlags,
  SessionContext,
} from "../shared";

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
  flags: Pick<GlobalFlags, "project" | "session">,
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

/**
 * How the calling command lets a caller name a dev server. The resolution is
 * shared; the recovery text is not, because "which flag" and "what else can I
 * do instead" are each one command's own vocabulary.
 */
export interface DevInstanceSelector {
  /** The name the caller chose, when several dev servers run. */
  name: string | undefined;
  /** How to choose one, e.g. "pass --dev <name> to select one". */
  disambiguate: string;
  /** A way to reach the dev server without this lookup, when the command has one. */
  bypass?: string;
}

export interface ResolveDevInstanceParams {
  flags: GlobalFlags;
  selector: DevInstanceSelector;
  /**
   * The invoking session, already resolved. Passed in rather than resolved
   * here so the session-env read stays in the calling command's own file —
   * `session-env-inventory.arch.test.ts` attributes it by source path, and a
   * command resolving its identity through a helper would classify as that
   * helper and disappear from the ratchet.
   */
  context: SessionContext;
  env: CliEnv;
  host: CliHost;
}

/**
 * The running dev server this session or workflow context owns.
 *
 * Every caller of this is addressing a SECOND CC instance, so the read that
 * finds it states no build stamp: the dev server runs the branch while this
 * binary comes from whichever build published it, and gating the lookup on
 * parity would refuse exactly the callers — fixtures and cross-instance
 * diagnosis — that exist because the two builds differ. The registry envelope
 * is schema-checked instead, and a shape this binary cannot read is reported as
 * that rather than degraded into "nothing is running".
 */
export async function resolveRunningDevInstance(
  params: ResolveDevInstanceParams,
): Promise<
  { ok: true; instance: DevInstance } | { ok: false; result: CliResult }
> {
  const { flags, selector, context, env, host } = params;
  const json = flags.json;
  const bypass = selector.bypass === undefined ? "" : `, ${selector.bypass}`;

  const inferred = inferDevCommandTarget(flags, env);
  if (!inferred.ok) {
    return { ok: false, result: usageFailure(inferred.message, json) };
  }

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path: devServerRequestPath(context, inferred.target),
    unstamped: true,
  });
  if (result.kind !== "ok") {
    // The classic misfire: an agent hit the two-instance trap, pointed
    // CC_SERVER_URL at the dev server to "fix" it, and now asks that instance
    // to resolve a session it has never heard of.
    if (result.kind === "error" && result.status === 404) {
      return {
        ok: false,
        result: failure({
          exitCode: EXIT_OPERATION_FAILED,
          message: `${result.error} — ${context.server} could not resolve this session (${context.project}/${context.session})`,
          hint: `a dev server is resolved through the MANAGING server; if CC_SERVER_URL is pointed at a dev server, unset it${bypass}`,
          json,
        }),
      };
    }
    return { ok: false, result: failureFromRequest(result, json) };
  }

  const parsed = devServersStatusResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return {
      ok: false,
      result: failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: `unexpected dev-servers response from ${context.server}`,
        hint: "that server's dev-server surface differs from this cctl's — re-run with the cctl it publishes (`cctl doctor` prints the path)",
        json,
      }),
    };
  }

  const running = parsed.data.servers.filter(
    (s) => s.status === "running" && s.port !== null,
  );
  if (running.length === 0) {
    return {
      ok: false,
      result: failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: "no running dev server to target",
        hint: "start one with 'cctl dev ensure', then re-run",
        json,
      }),
    };
  }

  const chosen =
    selector.name === undefined
      ? running.length === 1
        ? running[0]
        : undefined
      : running.find((s) => s.serverName === selector.name);
  if (chosen === undefined) {
    const names = running.map((s) => s.serverName).join(", ");
    return {
      ok: false,
      result: usageFailure(
        selector.name === undefined
          ? `multiple dev servers running (${names}); ${selector.disambiguate}`
          : `no running dev server named "${selector.name}" (running: ${names})`,
        json,
      ),
    };
  }

  return {
    ok: true,
    instance: {
      serverName: chosen.serverName,
      url: `http://localhost:${chosen.port}`,
      worktreePath: chosen.worktreePath,
    },
  };
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
