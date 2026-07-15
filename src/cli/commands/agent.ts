import {
  agentRunCreatedResponseSchema,
  agentRunStatusResponseSchema,
  type AgentRunStatusResponse,
} from "@/lib/agent-runs/schemas";
import { dispatchGroup } from "../dispatch";
import { flagNamesFor } from "../help-registry";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  checkFlags,
  cliRequest,
  encodePathSegment,
  failure,
  failureFromRequestNotFoundAsUsage,
  readJsonObjectFile,
  render,
  resolveSessionContext,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliResult,
  type GlobalFlags,
  type SessionContext,
} from "../shared";

/**
 * `cctl agent run|status|cancel` — the job-shaped one-shot sub-agent runner.
 * The prompt payload names the backend (`{"backend": "codex", ...}`);
 * execution stays server-side. The CLI creates a run, optionally long-polls it
 * to completion (`--wait`), and can recover or abort a run that outlived a
 * killed client via `status`/`cancel`.
 */

const POLL_INTERVAL_MS = 1000;
/** Client-side `--wait` budget when `--timeout` is omitted (the run itself is unbounded by this). */
const DEFAULT_WAIT_BUDGET_MS = 30 * 60 * 1000;

/**
 * Parse a human duration (`25m`, `90s`, `500ms`, `2h`, or bare seconds `1800`)
 * into milliseconds. Returns null on malformed input.
 */
export function parseDuration(input: string): number | null {
  const match = /^(\d+)(ms|s|m|h)?$/.exec(input.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  switch (match[2]) {
    case "ms":
      return value;
    case "h":
      return value * 3_600_000;
    case "m":
      return value * 60_000;
    case "s":
    case undefined:
      return value * 1000;
    default:
      return null;
  }
}

function agentRunsPath(context: SessionContext): string {
  return `/api/projects/${encodePathSegment(context.project)}/sessions/${encodePathSegment(context.session)}/agent-runs`;
}

export async function runAgent(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  return dispatchGroup({
    group: ["agent"],
    rest,
    json: flags.json,
    handlers: {
      run: (r) => runAgentRun(r, flags, values, env, host),
      status: (r) => runAgentStatus(r, flags, values, env, host),
      cancel: (r) => runAgentCancel(r, flags, values, env, host),
    },
  });
}

async function runAgentRun(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("agent run"), json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure("agent run takes no positional arguments", json);
  }

  const filePath = values["file"];
  if (filePath === undefined) {
    return usageFailure("agent run requires --file <prompt.json>", json);
  }

  const wait = values["wait"] !== undefined;
  const timeoutValue = values["timeout"];
  if (timeoutValue !== undefined && !wait) {
    return usageFailure("agent run: --timeout only applies with --wait", json);
  }
  let waitBudgetMs = DEFAULT_WAIT_BUDGET_MS;
  if (timeoutValue !== undefined) {
    const parsedTimeout = parseDuration(timeoutValue);
    if (parsedTimeout === null) {
      return usageFailure(
        `invalid --timeout "${timeoutValue}" — use e.g. 25m, 90s, 500ms`,
        json,
      );
    }
    waitBudgetMs = parsedTimeout;
  }

  const prompt = await readJsonObjectFile(host, filePath, "prompt", json);
  if (!prompt.ok) return prompt.result;

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const createResult = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: agentRunsPath(context),
    body: prompt.value,
  });
  if (createResult.kind !== "ok")
    return failureFromRequestNotFoundAsUsage(createResult, json);

  const created = agentRunCreatedResponseSchema.safeParse(createResult.body);
  if (!created.success) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: "unexpected create response from the CC server",
      json,
    });
  }
  const runId = created.data.runId;

  if (!wait) {
    const hint = `poll with 'cctl agent status ${runId}'; cancel with 'cctl agent cancel ${runId}'`;
    return {
      exitCode: EXIT_OK,
      stdout: render(json, `started agent run ${runId}\n`, {
        ok: true,
        runId,
        hint,
      }),
      stderr: "",
    };
  }

  return waitForAgentRun(context, runId, waitBudgetMs, json, host);
}

/** Long-poll a run to a terminal state, or give up (exit 1) when the client budget elapses. */
async function waitForAgentRun(
  context: SessionContext,
  runId: string,
  budgetMs: number,
  json: boolean,
  host: CliHost,
): Promise<CliResult> {
  const maxPolls = Math.max(1, Math.ceil(budgetMs / POLL_INTERVAL_MS));
  for (let attempt = 0; ; attempt++) {
    const statusResult = await cliRequest(host, {
      server: context.server,
      token: context.token,
      tokenSource: context.tokenSource,
      method: "GET",
      path: `${agentRunsPath(context)}/${encodePathSegment(runId)}`,
    });
    if (statusResult.kind !== "ok")
      return failureFromRequestNotFoundAsUsage(statusResult, json);

    const parsed = agentRunStatusResponseSchema.safeParse(statusResult.body);
    const run = parsed.success ? parsed.data : null;

    if (run && run.status !== "running") {
      if (run.status === "completed") return completedResult(run, json);
      // A killed run mid-wait is not a client failure of the CLI — but a run
      // that actually failed server-side is: surface it (exit 1).
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: run.error ?? `agent run ${runId} ${run.status}`,
        json,
      });
    }

    if (attempt >= maxPolls) {
      // The run continues server-side — recovery is a status poll, not a rerun.
      return failure({
        exitCode: EXIT_OPERATION_FAILED,
        message: `agent run ${runId} still running after ${Math.round(
          budgetMs / 1000,
        )}s — the run continues server-side`,
        hint: `recover the result with 'cctl agent status ${runId}'`,
        json,
      });
    }
    await host.sleep(POLL_INTERVAL_MS);
  }
}

/** The read-the-docs hint (interpolated from response facts). */
function referenceDocsHint(count: number): string {
  return `the agent registered ${count} reference documents — read them before building on the summary`;
}

/** Format a completed run: the summary + referenceDocuments result shape. Exit 0. */
function completedResult(
  run: AgentRunStatusResponse,
  json: boolean,
): CliResult {
  const docs = run.referenceDocuments ?? [];
  const summary = run.summary ?? "";
  const hint = docs.length > 0 ? referenceDocsHint(docs.length) : undefined;

  const humanParts = [summary.endsWith("\n") ? summary : `${summary}\n`];
  if (docs.length > 0) {
    humanParts.push("\nreference documents:\n");
    humanParts.push(
      `${docs.map((d) => `  ${d.filePath}  —  ${d.description}`).join("\n")}\n`,
    );
  }

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanParts.join(""), {
      ok: true,
      status: "completed",
      summary,
      referenceDocuments: docs,
      ...(hint ? { hint } : {}),
    }),
    stderr: "",
  };
}

async function runAgentStatus(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("agent status"), json);
  if (denied) return denied;

  const runId = rest[0];
  if (runId === undefined) {
    return usageFailure("agent status requires a <runId> argument", json);
  }
  if (rest.length > 1) {
    return usageFailure("agent status takes a single <runId> argument", json);
  }

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path: `${agentRunsPath(context)}/${encodePathSegment(runId)}`,
  });
  if (result.kind !== "ok")
    return failureFromRequestNotFoundAsUsage(result, json);

  const parsed = agentRunStatusResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: "unexpected status response from the CC server",
      json,
    });
  }
  const run = parsed.data;

  // `status` is observational — reading it succeeds (exit 0) regardless of the
  // run's own outcome; a completed run reproduces the full result shape so a
  // client killed mid-`--wait` recovers it here.
  if (run.status === "completed") return completedResult(run, json);

  const humanLine =
    run.status === "running"
      ? `agent run ${runId} is running\n`
      : `agent run ${runId} ${run.status}${run.error ? `: ${run.error}` : ""}\n`;

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanLine, {
      ok: true,
      status: run.status,
      ...(run.error !== undefined ? { error: run.error } : {}),
    }),
    stderr: "",
  };
}

async function runAgentCancel(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, flagNamesFor("agent cancel"), json);
  if (denied) return denied;

  const runId = rest[0];
  if (runId === undefined) {
    return usageFailure("agent cancel requires a <runId> argument", json);
  }
  if (rest.length > 1) {
    return usageFailure("agent cancel takes a single <runId> argument", json);
  }

  const resolved = await resolveSessionContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${agentRunsPath(context)}/${encodePathSegment(runId)}/cancel`,
  });
  if (result.kind !== "ok")
    return failureFromRequestNotFoundAsUsage(result, json);

  // No hint — cancel is terminal.
  return {
    exitCode: EXIT_OK,
    stdout: render(json, `cancelled agent run ${runId}\n`, { ok: true }),
    stderr: "",
  };
}
