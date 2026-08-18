import {
  agentProfileLibraryEntrySchema,
  agentProfileLibraryListingSchema,
  formatAgentProfileRef,
  parseAgentProfileRef,
  type AgentProfileLibraryDiagnostic,
  type AgentProfileLibraryEntry,
  type AgentProfileLibraryItem,
  type AgentProfileRefParseFailureKind,
} from "@/lib/agent-profiles/schemas";
import {
  agentRunCreatedResponseSchema,
  agentRunStatusResponseSchema,
  type AgentRunStatusResponse,
} from "@/lib/agent-runs/schemas";
import { dispatchGroup } from "../dispatch";
import { awaitJob } from "../job-wait";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  EXIT_USAGE,
  checkFlags,
  cliRequest,
  encodePathSegment,
  failure,
  failureFromRequestNotFoundAsUsage,
  readJsonObjectFile,
  render,
  resolveProjectContext,
  resolveSessionContext,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliResult,
  type GlobalFlags,
  type ProjectContext,
  type SessionContext,
} from "../shared";

/**
 * `cctl agent` covers two capabilities behind one noun.
 *
 * `run|status|cancel` is the job-shaped one-shot sub-agent runner. The prompt
 * payload names the backend (`{"backend": "codex", ...}`); execution stays
 * server-side. The CLI creates a run, optionally long-polls it to completion
 * (`--wait`), and can recover or abort a run that outlived a killed client via
 * `status`/`cancel`. These are session-scoped: a run executes in a session's
 * worktree.
 *
 * `list|get` is the agent profile library's read surface (R11, D24) — the
 * machine-discoverable selection surface a planning agent staffs assignments
 * from. Both are server-backed through the project-scoped library API rather
 * than reading storage, so the CLI sees exactly what the service sees,
 * including tier provenance and quarantine diagnostics. They resolve PROJECT
 * context only: the project route tree reaches all three tiers, and a project
 * conversation must be able to read the library.
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

/**
 * The project-scoped library route. The route TREE is the scope, so this one
 * path reaches every tier a project can see (builtin, global, and its own
 * project tier) — there is no per-tier endpoint to choose between.
 */
function agentProfilesPath(context: ProjectContext): string {
  return `/api/projects/${encodePathSegment(context.project)}/agent-profiles`;
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
      list: (r) => runAgentList(r, flags, values, env, host),
      get: (r) => runAgentGet(r, flags, values, env, host),
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
  const denied = checkFlags(values, "agent run", json);
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

/** The one wording for a status body this binary cannot read, shared by `--wait` and `status`. */
const UNEXPECTED_STATUS_RESPONSE =
  "unexpected status response from the CC server";

/**
 * One poll's outcome. A refused request is a status the classifier terminates
 * on rather than a parse failure, so a 404 keeps its usage exit class instead
 * of being retried as an unreadable body.
 */
type AgentRunPollStatus =
  | { kind: "run"; run: AgentRunStatusResponse }
  | { kind: "request_failed"; result: CliResult };

/** Long-poll a run to a terminal state, or give up (exit 1) when the client budget elapses. */
async function waitForAgentRun(
  context: SessionContext,
  runId: string,
  budgetMs: number,
  json: boolean,
  host: CliHost,
): Promise<CliResult> {
  return awaitJob<AgentRunPollStatus>(host, {
    json,
    timeoutMs: budgetMs,
    pollIntervalMs: POLL_INTERVAL_MS,
    async poll() {
      const statusResult = await cliRequest(host, {
        server: context.server,
        token: context.token,
        tokenSource: context.tokenSource,
        method: "GET",
        path: `${agentRunsPath(context)}/${encodePathSegment(runId)}`,
      });
      if (statusResult.kind !== "ok") {
        return {
          ok: true,
          status: {
            kind: "request_failed",
            result: failureFromRequestNotFoundAsUsage(statusResult, json),
          },
        };
      }
      const parsed = agentRunStatusResponseSchema.safeParse(statusResult.body);
      if (!parsed.success) {
        return { ok: false, parseError: UNEXPECTED_STATUS_RESPONSE };
      }
      return { ok: true, status: { kind: "run", run: parsed.data } };
    },
    classify(status) {
      if (status.kind === "request_failed") {
        return { terminal: true, result: status.result };
      }
      const run = status.run;
      if (run.status === "running") return { terminal: false };
      if (run.status === "completed") {
        return { terminal: true, result: completedResult(run, json) };
      }
      // A killed run mid-wait is not a client failure of the CLI — but a run
      // that actually failed server-side is: surface it (exit 1).
      return {
        terminal: true,
        result: failure({
          exitCode: EXIT_OPERATION_FAILED,
          message: run.error ?? `agent run ${runId} ${run.status}`,
          json,
        }),
      };
    },
    onTimeout(elapsedMs) {
      // The run continues server-side — recovery is a status poll, not a rerun.
      return {
        exitCode: EXIT_OPERATION_FAILED,
        message: `agent run ${runId} still running after ${Math.round(
          elapsedMs / 1000,
        )}s — the run continues server-side`,
        hint: `recover the result with 'cctl agent status ${runId}'`,
        json,
      };
    },
  });
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
  const denied = checkFlags(values, "agent status", json);
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
      message: UNEXPECTED_STATUS_RESPONSE,
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
  const denied = checkFlags(values, "agent cancel", json);
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

// ---------------------------------------------------------------------------
// The agent profile library (R11, D24)
// ---------------------------------------------------------------------------

/**
 * The wire spelling of each reference-parse refusal. The domain owns which
 * refusals exist and what each means; this owns only how the CLI names them, so
 * a new failure kind fails to compile here rather than shipping as an untyped
 * refusal.
 */
const REF_PARSE_REFUSAL_CODES: Record<AgentProfileRefParseFailureKind, string> =
  {
    unqualified: "agent_profile_ref_unqualified",
    unknown_tier: "agent_profile_ref_unknown_tier",
    invalid_id: "agent_profile_ref_invalid_id",
  };

function formatAudienceList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "-";
}

/**
 * One listing line: the qualified reference first, because that is what `get`
 * and every text boundary take back. Instruction text is structurally absent —
 * the listing projection does not carry it (R6.3).
 */
function formatProfileItem(item: AgentProfileLibraryItem): string {
  const head = `${formatAgentProfileRef(item.ref)} (rev ${item.revision})  ${item.name} — ${item.description}`;
  const meta = `    for: ${formatAudienceList(item.recommendedFor)}  tags: ${formatAudienceList(item.tags)}${item.readOnly ? "  read-only" : ""}`;
  return `${head}\n${meta}\n`;
}

function formatDiagnostic(diagnostic: AgentProfileLibraryDiagnostic): string {
  return `  ${diagnostic.tier}:${diagnostic.id} — ${diagnostic.reason}\n`;
}

async function runAgentList(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "agent list", json);
  if (denied) return denied;
  if (rest.length > 0) {
    return usageFailure("agent list takes no positional arguments", json);
  }

  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path: agentProfilesPath(context),
  });
  if (result.kind !== "ok")
    return failureFromRequestNotFoundAsUsage(result, json);

  const parsed = agentProfileLibraryListingSchema.safeParse(result.body);
  if (!parsed.success) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: "unexpected agent profile listing from the CC server",
      json,
    });
  }
  const { profiles, diagnostics } = parsed.data;

  const humanParts = [
    `${profiles.length} agent profile${profiles.length === 1 ? "" : "s"}\n`,
    ...profiles.map(formatProfileItem),
  ];
  if (diagnostics.length > 0) {
    humanParts.push("unreadable records (quarantined):\n");
    humanParts.push(...diagnostics.map(formatDiagnostic));
  }

  return {
    exitCode: EXIT_OK,
    stdout: render(json, humanParts.join(""), {
      ok: true,
      profiles,
      diagnostics,
      hint: "read one profile's full text with 'cctl agent get <tier:id>'",
    }),
    stderr: "",
  };
}

/** The full record, text mode: metadata first, then the block it exists to carry. */
function formatProfileEntry(entry: AgentProfileLibraryEntry): string {
  return [
    `${formatAgentProfileRef({ tier: entry.tier, id: entry.id })} (rev ${entry.revision})  ${entry.name}\n`,
    `${entry.description}\n`,
    `for: ${formatAudienceList(entry.recommendedFor)}  tags: ${formatAudienceList(entry.tags)}  ${entry.readOnly ? "read-only" : "editable"}\n`,
    "\n",
    `${entry.instructions.endsWith("\n") ? entry.instructions : `${entry.instructions}\n`}`,
  ].join("");
}

async function runAgentGet(
  rest: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const json = flags.json;
  const denied = checkFlags(values, "agent get", json);
  if (denied) return denied;

  const refText = rest[0];
  if (refText === undefined) {
    return usageFailure("agent get requires a <tier:id> argument", json);
  }
  if (rest.length > 1) {
    return usageFailure("agent get takes a single <tier:id> argument", json);
  }

  // A deterministic local check, so an unqualified reference is refused before
  // any round-trip: sibling tiers can hold the same id, and guessing one would
  // read a profile nobody addressed.
  const ref = parseAgentProfileRef(refText);
  if (!ref.ok) {
    const { kind, message, text, offset, length } = ref.failure;
    return failure({
      exitCode: EXIT_USAGE,
      message,
      code: REF_PARSE_REFUSAL_CODES[kind],
      details: { kind, text, offset, length },
      hint: "list the qualified references with 'cctl agent list'",
      json,
    });
  }

  const resolved = await resolveProjectContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const context = resolved.context;

  const result = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path: `${agentProfilesPath(context)}/${encodePathSegment(ref.ref.tier)}/${encodePathSegment(ref.ref.id)}`,
  });
  // A reference that resolves to nothing is a caller mistake, not a server
  // "no": the 404 carries the service's typed refusal code, which survives into
  // the envelope.
  if (result.kind !== "ok")
    return failureFromRequestNotFoundAsUsage(result, json);

  const parsed = agentProfileLibraryEntrySchema.safeParse(result.body);
  if (!parsed.success) {
    return failure({
      exitCode: EXIT_OPERATION_FAILED,
      message: "unexpected agent profile response from the CC server",
      json,
    });
  }

  return {
    exitCode: EXIT_OK,
    stdout: render(json, formatProfileEntry(parsed.data), {
      ok: true,
      profile: parsed.data,
    }),
    stderr: "",
  };
}
