import path from "node:path";
import { resolveConfigDirFrom } from "@/lib/config/config-dir";
import {
  validationListResponseSchema,
  validationPollResponseSchema,
  validationSubmitResponseSchema,
  VALIDATION_LEASE_HEADER,
  VALIDATION_POLL_MAX_WAIT_MS,
  type ValidationSubmitBody,
  type ValidationListCommand,
  type ValidationListResponse,
  type ValidationPollResponse,
} from "@/lib/validation/api-schemas";
import type {
  ValidationRunResult,
  ValidationScope,
} from "@/lib/validation/schemas";
import { conversationTargetApiBase } from "@/lib/conversations/conversation-target";
import { dispatchGroup } from "../dispatch";
import { awaitJob } from "../job-wait";
import { parseDuration } from "./agent";
import {
  EXIT_OK,
  EXIT_OPERATION_FAILED,
  EXIT_USAGE,
  checkFlags,
  cliRequest,
  encodePathSegment,
  failure,
  failureFromRequest,
  failureFromRequestNotFoundAsUsage,
  render,
  resolveConversationTargetContext,
  usageFailure,
  type CliEnv,
  type CliHost,
  type CliRequestResult,
  type CliResult,
  type ConversationTargetContext,
  type GlobalFlags,
} from "../shared";

/**
 * Floor on one wait iteration. A server that honours the status hold already
 * spends far more than this inside the request itself, so it costs nothing
 * there; against a server that answers from current state it is the whole
 * cadence, which is how a wait degrades instead of spinning.
 */
const POLL_INTERVAL_MS = 1_000;

/**
 * How long a status request may ask the server to hold, and the slack left for
 * the answer to travel after the hold expires. The ceiling is the server's own
 * (`VALIDATION_POLL_MAX_WAIT_MS`), which sits well under `DEFAULT_LEASE_TTL_MS`
 * (`src/lib/validation/lease.ts`, 60s): the submitter's lease is renewed once
 * per status request, so the hold is also the gap between renewals, and a hold
 * approaching the TTL would let the sweep reap the very run its own submitter
 * is healthily waiting on.
 */
const LONG_POLL_WAIT_MS = VALIDATION_POLL_MAX_WAIT_MS;
const LONG_POLL_GRACE_MS = 2_000;

/**
 * The client wait budget. It bounds a wait that can no longer end — not a run
 * that is simply long: registered command timeouts already reach an hour, and a
 * `--queue-if-busy` can queue behind every older waiter before the run's own
 * clock starts. A budget near those durations would abandon observations that
 * succeed today, so the default sits well above them and `--timeout` is how a
 * caller who wants a tighter one asks for it.
 */
const DEFAULT_WAIT_BUDGET_MS = 2 * 60 * 60 * 1_000;
const DEFAULT_WAIT_TIMEOUT_LABEL = "2h";

function validationPath(context: ConversationTargetContext): string {
  return `${conversationTargetApiBase(context.target)}/validation`;
}

function validationLeaseFilePath(
  runId: string,
  env: CliEnv,
  host: CliHost,
): string {
  return path.join(
    resolveConfigDirFrom(env, host),
    `validation-lease-${encodeURIComponent(runId)}.token`,
  );
}

async function removeStoredLease(
  filePath: string,
  host: CliHost,
): Promise<void> {
  try {
    await host.removeFile?.(filePath);
  } catch {
    // The lease is already terminal or expiring; stale local cleanup must not
    // replace the validation result the caller is waiting for.
  }
}

function withJsonPayload(
  result: CliResult,
  json: boolean,
  payload: Record<string, unknown>,
): CliResult {
  if (!json || result.stdout === "") return result;
  const envelope: unknown = JSON.parse(result.stdout);
  if (typeof envelope !== "object" || envelope === null) return result;
  return {
    ...result,
    stdout: `${JSON.stringify({ ...envelope, ...payload })}\n`,
  };
}

function validationFailure(
  input: Parameters<typeof failure>[0],
  payload: Record<string, unknown> = {},
): CliResult {
  return withJsonPayload(failure(input), input.json, payload);
}

function unexpectedResponse(message: string, json: boolean): CliResult {
  return failure({ exitCode: EXIT_OPERATION_FAILED, message, json });
}

export async function runValidate(
  rest: string[],
  passthrough: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  return dispatchGroup({
    group: ["validate"],
    rest,
    json: flags.json,
    handlers: {
      list: (args) =>
        runValidateList(args, passthrough, flags, values, env, host),
      run: (args) =>
        runValidateRun(args, passthrough, flags, values, env, host),
      status: (args) =>
        runValidateStatus(args, passthrough, flags, values, env, host),
      cancel: (args) =>
        runValidateCancel(args, passthrough, flags, values, env, host),
    },
  });
}

async function resolveContext(
  flags: GlobalFlags,
  env: CliEnv,
  host: CliHost,
): Promise<
  | { ok: true; context: ConversationTargetContext }
  | { ok: false; result: CliResult }
> {
  return resolveConversationTargetContext(flags, env, host);
}

async function requestList(
  context: ConversationTargetContext,
  host: CliHost,
): Promise<
  | { kind: "ok"; value: ValidationListResponse }
  | {
      kind: "request_error";
      result: Exclude<CliRequestResult, { kind: "ok" }>;
    }
  | { kind: "invalid_response" }
> {
  const response = await cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "GET",
    path: validationPath(context),
  });
  if (response.kind !== "ok") {
    return { kind: "request_error", result: response };
  }
  const parsed = validationListResponseSchema.safeParse(response.body);
  if (!parsed.success) {
    return { kind: "invalid_response" };
  }
  return { kind: "ok", value: parsed.data };
}

// A scope-aware registration is rendered with every omitted weight resolved,
// so the line states what each execution actually reserves rather than what
// the project happened to spell out. A command with no changed executable
// resolves every request to full, so quoting a scoped weight there would
// advertise a reservation that can never happen; the scoped weight is likewise
// shown only where paths may be forwarded.
function formatRegisteredCost(command: ValidationListCommand): string {
  const cost = command.cost;
  if (typeof cost === "number") return `cost ${cost}`;
  if (command.changedScope !== "native") return `cost ${cost.full}`;
  const changed = cost.changed ?? cost.full;
  const detail = [`changed ${changed}`];
  if (command.pathArgs === "paths") {
    if (cost.paths === undefined) {
      detail.push(`paths ${changed} flat`);
    } else if (cost.paths.perPath === 0) {
      detail.push(`paths ${cost.paths.base} flat`);
    } else {
      // The charged unit is a forwarded path, which may be a directory.
      detail.push(`paths ${cost.paths.base}+${cost.paths.perPath}/path`);
    }
  }
  return `cost ${cost.full} (${detail.join(", ")})`;
}

function renderList(listed: ValidationListResponse, json: boolean): CliResult {
  const capacity = `${listed.capacity.inUse} of ${listed.capacity.limit} capacity units in use; queue depth ${listed.capacity.queueDepth}`;
  const commandLines = listed.commands.map((command) => {
    const description = command.description ? ` — ${command.description}` : "";
    const changed =
      command.changedScope === "native" ? "changed native" : "changed → full";
    const paths = command.pathArgs === "paths" ? "  paths" : "";
    return `${command.name}  ${formatRegisteredCost(command)}  ${changed}${paths}  ${command.enabled ? "enabled" : "disabled"}${description}`;
  });
  return {
    exitCode: EXIT_OK,
    stdout: render(
      json,
      `${capacity}\n${commandLines.length > 0 ? `${commandLines.join("\n")}\n` : "no validation commands registered\n"}`,
      { ok: true, ...listed },
    ),
    stderr: "",
  };
}

async function runValidateList(
  rest: string[],
  passthrough: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const denied = checkFlags(values, "validate list", flags.json);
  if (denied) return denied;
  if (rest.length > 0 || passthrough.length > 0) {
    return usageFailure(
      "validate list takes no positional arguments",
      flags.json,
    );
  }
  const resolved = await resolveContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const listed = await requestList(resolved.context, host);
  if (listed.kind === "request_error") {
    return failureFromRequestNotFoundAsUsage(listed.result, flags.json);
  }
  if (listed.kind === "invalid_response") {
    return unexpectedResponse(
      "unexpected validation list response from the CC server",
      flags.json,
    );
  }
  return renderList(listed.value, flags.json);
}

function capacityFailure(
  commandName: string,
  result: Extract<ValidationRunResult, { kind: "capacity_unavailable" }>,
  json: boolean,
): CliResult {
  const waiterText = result.blockedByOlderWaiter
    ? `, and ${result.queueDepth} older waiter${result.queueDepth === 1 ? " has" : "s have"} FIFO priority (queue depth ${result.queueDepth})`
    : "";
  const message = `Validation "${commandName}" was not started: it costs ${result.cost}, but ${result.inUse} of ${result.limit} capacity units are in use${waiterText}.`;
  return validationFailure(
    {
      exitCode: EXIT_OPERATION_FAILED,
      message,
      hint: `run 'cctl validate run ${commandName} --queue-if-busy' to queue it`,
      code: "capacity_unavailable",
      json,
    },
    {
      cost: result.cost,
      inUse: result.inUse,
      limit: result.limit,
      queueDepth: result.queueDepth,
      blockedByOlderWaiter: result.blockedByOlderWaiter,
    },
  );
}

function notStartedResult(
  commandName: string,
  result: Extract<
    ValidationRunResult,
    {
      kind:
        | "skipped_by_policy"
        | "capacity_unavailable"
        | "command_not_found"
        | "cost_exceeds_limit";
    }
  >,
  json: boolean,
): CliResult {
  switch (result.kind) {
    case "skipped_by_policy":
      // Tier 2, not tier 3: the skip text states an invariant to keep true
      // ("it is handled by the script validator", "do not run it by other
      // means"), not a step to perform now. The renderer owns the one line.
      return {
        exitCode: EXIT_OK,
        stdout: render(json, "", {
          ok: true,
          status: "skipped_by_policy",
          code: "validation_policy_skipped",
          reminders: [result.message],
        }),
        stderr: "",
      };
    case "capacity_unavailable":
      return capacityFailure(commandName, result, json);
    case "command_not_found": {
      const registered =
        result.knownCommands.length > 0
          ? result.knownCommands.join(", ")
          : "(none)";
      return validationFailure(
        {
          exitCode: EXIT_USAGE,
          message: `Unknown validation command "${result.name}". Registered commands: ${registered}.`,
          code: "validation_command_not_found",
          json,
        },
        { name: result.name, knownCommands: result.knownCommands },
      );
    }
    case "cost_exceeds_limit":
      return validationFailure(
        {
          exitCode: EXIT_OPERATION_FAILED,
          message: `Validation "${result.name}" costs ${result.cost}, exceeding the global limit of ${result.limit}.`,
          detail:
            "Register a lower-worker command profile, reduce its worker cap and honest cost together, or raise the machine limit.",
          code: "validation_cost_exceeds_limit",
          json,
        },
        { name: result.name, cost: result.cost, limit: result.limit },
      );
  }
}

/**
 * What a submitted run is, for the verdict line: the command as the caller
 * named it plus the scope the server resolved. Threaded from submission because
 * a terminal result carries neither.
 */
interface ValidationRunDescriptor {
  commandName: string;
  requestedScope: ValidationScope;
  effectiveScope: ValidationScope;
}

/**
 * The stable pass verdict, in text. Without it a quiet green run printed
 * nothing, so a real pass and a run that matched zero files (a mistyped scope
 * path) were the same bytes. A run whose scope the server never resolved into a
 * file list carries no count, and the line says nothing rather than guessing.
 */
function passVerdictLine(
  run: ValidationRunDescriptor,
  runId: string,
  filesMatched: number | undefined,
): string {
  const parts = [
    `scope ${run.requestedScope}→${run.effectiveScope}`,
    ...(filesMatched !== undefined && filesMatched > 0
      ? [`${filesMatched} file${filesMatched === 1 ? "" : "s"}`]
      : []),
    `run ${runId}`,
  ];
  return `validation passed: ${run.commandName} (${parts.join(", ")})`;
}

/** The disclosure that separates a real green from a green over nothing. */
const VACUOUS_PASS_LINE =
  "0 files matched — vacuous pass, verify the scope path";

/**
 * How many trailing lines of a passing run's captured output are relayed. A
 * pass is summarized by its verdict line; the evidence a caller re-reads lives
 * in the envelope and in `validate status`. The failure arm relays in full —
 * there the output IS the finding.
 */
const PASS_OUTPUT_TAIL_LINES = 20;

function passOutputRelay(output: string, runId: string): string {
  const lines = output.replace(/\n+$/, "").split("\n");
  if (lines.length === 1 && lines[0] === "") return "";
  if (lines.length <= PASS_OUTPUT_TAIL_LINES) return `${lines.join("\n")}\n`;
  const tail = lines.slice(-PASS_OUTPUT_TAIL_LINES);
  return `…${tail.length} of ${lines.length} output lines shown (tail) — full output: cctl validate status ${runId} --json\n${tail.join("\n")}\n`;
}

function terminalRunResult(
  result: Exclude<
    ValidationRunResult,
    {
      kind:
        | "skipped_by_policy"
        | "capacity_unavailable"
        | "queued"
        | "command_not_found"
        | "cost_exceeds_limit";
    }
  >,
  json: boolean,
  run: ValidationRunDescriptor,
  requireMatch: boolean,
): CliResult {
  const scope = {
    requestedScope: run.requestedScope,
    effectiveScope: run.effectiveScope,
  };
  let rendered: CliResult;
  switch (result.kind) {
    case "passed": {
      const vacuous = result.filesMatched === 0;
      if (vacuous && requireMatch) {
        rendered = validationFailure(
          {
            exitCode: EXIT_OPERATION_FAILED,
            message: `${VACUOUS_PASS_LINE} (${run.commandName}, run ${result.runId})`,
            code: "validation_no_files_matched",
            json,
          },
          {
            runId: result.runId,
            commandName: run.commandName,
            filesMatched: 0,
          },
        );
        break;
      }
      const verdict = [
        passVerdictLine(run, result.runId, result.filesMatched),
        ...(vacuous ? [VACUOUS_PASS_LINE] : []),
      ].join("\n");
      rendered = {
        exitCode: EXIT_OK,
        stdout: render(
          json,
          `${verdict}\n${passOutputRelay(result.output, result.runId)}`,
          {
            ok: true,
            code: "validation_passed",
            commandName: run.commandName,
            ...result,
          },
        ),
        stderr: "",
      };
      break;
    }
    case "failed":
      rendered = validationFailure(
        {
          exitCode: EXIT_OPERATION_FAILED,
          message: `Validation failed${result.exitCode === null ? " before the command started" : ` with exit ${result.exitCode}`}.`,
          ...(result.output ? { detail: result.output } : {}),
          code: "validation_failed",
          json,
        },
        {
          runId: result.runId,
          validationExitCode: result.exitCode,
          output: result.output,
        },
      );
      break;
    case "timed_out":
      rendered = validationFailure(
        {
          exitCode: EXIT_OPERATION_FAILED,
          message: `Validation timed out after ${result.timeoutMs}ms.`,
          ...(result.output ? { detail: result.output } : {}),
          code: "validation_timed_out",
          json,
        },
        { ...result },
      );
      break;
    case "cancelled":
      rendered = validationFailure(
        {
          exitCode: EXIT_OPERATION_FAILED,
          message: `Validation run ${result.runId} was cancelled.`,
          code: "validation_cancelled",
          json,
        },
        { runId: result.runId },
      );
      break;
    case "interrupted":
      rendered = validationFailure(
        {
          exitCode: EXIT_OPERATION_FAILED,
          message: `Validation run ${result.runId} was interrupted.`,
          code: "validation_interrupted",
          json,
        },
        { runId: result.runId },
      );
      break;
  }
  return withJsonPayload(rendered, json, scope);
}

function addProgress(
  result: CliResult,
  queuePositions: number[],
  json: boolean,
  host: CliHost,
): CliResult {
  if (json) {
    return withJsonPayload(result, true, { queuePositions });
  }
  if (host.writeStdout || queuePositions.length === 0) return result;
  const progress = queuePositions
    .map((position) => `queue position ${position}\n`)
    .join("");
  return { ...result, stdout: `${progress}${result.stdout}` };
}

function reportQueuePosition(
  runId: string,
  zeroBasedPosition: number | null,
  seen: number[],
  json: boolean,
  host: CliHost,
): void {
  if (zeroBasedPosition === null) return;
  const position = zeroBasedPosition + 1;
  if (seen[seen.length - 1] === position) return;
  seen.push(position);
  if (!json)
    host.writeStdout?.(`validation ${runId}: queue position ${position}\n`);
}

async function cancelOwnedRun(
  context: ConversationTargetContext,
  runId: string,
  leaseToken: string,
  host: CliHost,
): Promise<Awaited<ReturnType<typeof cliRequest>>> {
  return cliRequest(host, {
    server: context.server,
    token: context.token,
    tokenSource: context.tokenSource,
    method: "POST",
    path: `${validationPath(context)}/${encodePathSegment(runId)}/cancel`,
    headers: { [VALIDATION_LEASE_HEADER]: leaseToken },
  });
}

/**
 * One poll's outcome. A refused request is a status the classifier terminates
 * on rather than a parse failure, so a 404 keeps its usage exit class instead
 * of being retried as an unreadable body. A transport that gave up is
 * classified where the deadline is known: a request that reached it is the
 * hold expiring and is polled again, anything earlier is an unreachable
 * server and keeps its exit class.
 */
type ValidationWaitStatus =
  | { kind: "request_failed"; result: CliResult }
  | { kind: "connection"; timedOut: boolean; detail: string }
  | { kind: "polled"; response: ValidationPollResponse };

interface PollToTerminalInput {
  context: ConversationTargetContext;
  runId: string;
  leaseToken: string;
  initialPosition: number | null;
  run: ValidationRunDescriptor;
  budgetMs: number;
  timeoutLabel: string;
  requireMatch: boolean;
  json: boolean;
  host: CliHost;
}

async function pollToTerminal(input: PollToTerminalInput): Promise<CliResult> {
  const { context, runId, leaseToken, run, json, host } = input;
  const now = host.now ?? Date.now;
  const queuePositions: number[] = [];
  reportQueuePosition(runId, input.initialPosition, queuePositions, json, host);

  const waited = await awaitJob<ValidationWaitStatus>(host, {
    json,
    timeoutMs: input.budgetMs,
    pollIntervalMs: POLL_INTERVAL_MS,
    async poll(remainingBudgetMs) {
      // The hold ends early enough for its answer to arrive inside the budget
      // the caller asked for; when nothing is left for one, the request just
      // reads current state.
      const waitMs = Math.floor(
        Math.min(
          LONG_POLL_WAIT_MS,
          Math.max(0, remainingBudgetMs - LONG_POLL_GRACE_MS),
        ),
      );
      const deadlineMs = Math.max(
        1,
        Math.ceil(Math.min(remainingBudgetMs, waitMs + LONG_POLL_GRACE_MS)),
      );
      const requestStartedAt = now();
      const response = await cliRequest(host, {
        server: context.server,
        token: context.token,
        tokenSource: context.tokenSource,
        method: "GET",
        path: `${validationPath(context)}/${encodePathSegment(runId)}${waitMs > 0 ? `?waitMs=${waitMs}` : ""}`,
        headers: { [VALIDATION_LEASE_HEADER]: leaseToken },
        timeoutMs: deadlineMs,
      });
      if (response.kind === "connection") {
        return {
          ok: true,
          status: {
            kind: "connection",
            timedOut: Math.max(0, now() - requestStartedAt) >= deadlineMs,
            detail: response.detail,
          },
        };
      }
      if (response.kind !== "ok") {
        return {
          ok: true,
          status: {
            kind: "request_failed",
            result: failureFromRequestNotFoundAsUsage(response, json),
          },
        };
      }
      const parsed = validationPollResponseSchema.safeParse(response.body);
      if (!parsed.success) {
        return {
          ok: false,
          parseError:
            "unexpected validation status response from the CC server",
        };
      }
      // Queue movement is the only progress a queued run has; it is reported as
      // it arrives rather than replayed at the end.
      reportQueuePosition(
        runId,
        parsed.data.position,
        queuePositions,
        json,
        host,
      );
      return { ok: true, status: { kind: "polled", response: parsed.data } };
    },
    classify(status) {
      if (status.kind === "request_failed") {
        return { terminal: true, result: status.result };
      }
      if (status.kind === "connection") {
        if (status.timedOut) return { terminal: false };
        return {
          terminal: true,
          result: failureFromRequest(
            { kind: "connection", detail: status.detail },
            json,
          ),
        };
      }
      const terminal = status.response.result;
      if (terminal === null) return { terminal: false };
      if (terminal.kind === "cost_exceeds_limit") {
        return {
          terminal: true,
          result: notStartedResult(terminal.name, terminal, json),
        };
      }
      if (
        terminal.kind === "passed" ||
        terminal.kind === "failed" ||
        terminal.kind === "timed_out" ||
        terminal.kind === "cancelled" ||
        terminal.kind === "interrupted"
      ) {
        return {
          terminal: true,
          result: terminalRunResult(terminal, json, run, input.requireMatch),
        };
      }
      return {
        terminal: true,
        result: unexpectedResponse(
          `validation run ${runId} returned non-terminal result ${terminal.kind} from status`,
          json,
        ),
      };
    },
    onTimeout() {
      // The budget bounds only this client wait: the run holds its capacity
      // reservation server-side and reaches its own verdict.
      return {
        exitCode: EXIT_OPERATION_FAILED,
        message: `stopped waiting for validation run ${runId} after ${input.timeoutLabel} — the run continues server-side`,
        detail: `  continue: cctl validate status ${runId}`,
        hint: `read the verdict with 'cctl validate status ${runId}'`,
        code: "wait_timeout",
        details: {
          runId,
          continueWith: `cctl validate status ${runId}`,
        },
        json,
      };
    },
    async onAbort(signal) {
      const cancelled = await cancelOwnedRun(context, runId, leaseToken, host);
      if (cancelled.kind !== "ok") {
        return failureFromRequest(cancelled, json);
      }
      return validationFailure(
        {
          exitCode: EXIT_OPERATION_FAILED,
          message: `Cancelled validation run ${runId} after ${signal}.`,
          code: "validation_cancelled_by_signal",
          json,
        },
        { runId, signal },
      );
    },
  });

  return addProgress(waited, queuePositions, json, host);
}

async function runValidateRun(
  rest: string[],
  passthrough: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const denied = checkFlags(values, "validate run", flags.json);
  if (denied) return denied;
  const [commandName, ...extra] = rest;
  if (!commandName) {
    return usageFailure("validate run requires <name>", flags.json);
  }
  if (extra.length > 0) {
    return usageFailure(
      "validate run accepts scope paths only after a literal '--' separator",
      flags.json,
    );
  }
  const requestedScope = values["scope"] ?? "changed";
  if (requestedScope !== "changed" && requestedScope !== "full") {
    return usageFailure(
      '--scope must be either "changed" or "full"',
      flags.json,
    );
  }
  if (requestedScope === "full" && passthrough.length > 0) {
    return usageFailure(
      "validated paths require --scope changed and cannot narrow a full run",
      flags.json,
    );
  }
  const timeoutValue = values["timeout"];
  let budgetMs = DEFAULT_WAIT_BUDGET_MS;
  if (timeoutValue !== undefined) {
    const parsedTimeout = parseDuration(timeoutValue);
    if (parsedTimeout === null) {
      return usageFailure(
        `invalid --timeout "${timeoutValue}" — use e.g. 25m, 90s, 500ms`,
        flags.json,
      );
    }
    budgetMs = parsedTimeout;
  }
  const workflowExecutionId = env["CC_WORKFLOW_EXECUTION_ID"];
  const workflowContextId = env["CC_WORKFLOW_CONTEXT_ID"];
  if (
    (workflowExecutionId === undefined) !==
    (workflowContextId === undefined)
  ) {
    return usageFailure(
      "workflow identity is incomplete — CC_WORKFLOW_EXECUTION_ID and CC_WORKFLOW_CONTEXT_ID must both be set",
      flags.json,
    );
  }

  const resolved = await resolveContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const queueIfBusy = values["queue-if-busy"] !== undefined;
  const response = await cliRequest(host, {
    server: resolved.context.server,
    token: resolved.context.token,
    tokenSource: resolved.context.tokenSource,
    method: "POST",
    path: validationPath(resolved.context),
    body: {
      commandName,
      scope: requestedScope,
      queueIfBusy,
      ...(passthrough.length > 0 ? { scopePaths: passthrough } : {}),
      ...(env["CC_VALIDATION_RUN_ID"]
        ? { nestedValidationRunId: env["CC_VALIDATION_RUN_ID"] }
        : {}),
      ...(workflowExecutionId && workflowContextId
        ? { workflowExecutionId, workflowContextId }
        : {}),
    } satisfies ValidationSubmitBody,
  });
  if (response.kind !== "ok") {
    return failureFromRequestNotFoundAsUsage(response, flags.json);
  }
  const parsed = validationSubmitResponseSchema.safeParse(response.body);
  if (!parsed.success) {
    return unexpectedResponse(
      "unexpected validation submission response from the CC server",
      flags.json,
    );
  }
  if (parsed.data.kind === "not_started") {
    switch (parsed.data.result.kind) {
      case "skipped_by_policy":
      case "capacity_unavailable":
      case "command_not_found":
      case "cost_exceeds_limit":
        return notStartedResult(commandName, parsed.data.result, flags.json);
      default:
        return unexpectedResponse(
          "unexpected validation submission response from the CC server",
          flags.json,
        );
    }
  }
  if (parsed.data.lease === null) {
    return unexpectedResponse(
      "validation submission did not return the submitter lease",
      flags.json,
    );
  }
  const leaseFilePath = validationLeaseFilePath(parsed.data.runId, env, host);
  try {
    if (!host.writePrivateTextFile)
      throw new Error("private lease storage unavailable");
    await host.writePrivateTextFile(
      leaseFilePath,
      `${parsed.data.lease.token}\n`,
    );
  } catch {
    host.writeStdout?.(
      `validation ${parsed.data.runId}: lease held by this command; interrupt it to cancel\n`,
    );
  }
  try {
    return await pollToTerminal({
      context: resolved.context,
      runId: parsed.data.runId,
      leaseToken: parsed.data.lease.token,
      initialPosition: parsed.data.position,
      run: {
        commandName,
        requestedScope: parsed.data.requestedScope,
        effectiveScope: parsed.data.effectiveScope,
      },
      budgetMs,
      timeoutLabel: timeoutValue ?? DEFAULT_WAIT_TIMEOUT_LABEL,
      requireMatch: values["require-match"] !== undefined,
      json: flags.json,
      host,
    });
  } finally {
    await removeStoredLease(leaseFilePath, host);
  }
}

function renderActiveStatus(
  listed: ValidationListResponse,
  json: boolean,
): CliResult {
  const lines = listed.runs.map((run) => {
    const position =
      run.position === null ? "" : `  queue position ${run.position + 1}`;
    const scope =
      run.requestedScope === null || run.effectiveScope === null
        ? "scope unknown"
        : run.requestedScope === run.effectiveScope
          ? `scope ${run.effectiveScope}`
          : `scope ${run.requestedScope} → ${run.effectiveScope}`;
    return `${run.runId}  ${run.commandName}  ${run.status}  cost ${run.cost}  ${scope}${position}`;
  });
  return {
    exitCode: EXIT_OK,
    stdout: render(
      json,
      lines.length > 0
        ? `${lines.join("\n")}\n`
        : "no active validation runs\n",
      {
        ok: true,
        runs: listed.runs,
        capacity: listed.capacity,
      },
    ),
    stderr: "",
  };
}

function renderOneStatus(
  status: ValidationPollResponse,
  json: boolean,
): CliResult {
  const position =
    status.position === null ? "" : ` (queue position ${status.position + 1})`;
  const scope =
    status.requestedScope === null || status.effectiveScope === null
      ? "scope unknown"
      : status.requestedScope === status.effectiveScope
        ? `scope ${status.effectiveScope}`
        : `scope ${status.requestedScope} → ${status.effectiveScope}`;
  return {
    exitCode: EXIT_OK,
    stdout: render(
      json,
      `${status.runId}  ${status.status}  ${scope}${position}\n`,
      {
        ok: true,
        ...status,
      },
    ),
    stderr: "",
  };
}

async function runValidateStatus(
  rest: string[],
  passthrough: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const denied = checkFlags(values, "validate status", flags.json);
  if (denied) return denied;
  if (rest.length > 1 || passthrough.length > 0) {
    return usageFailure("validate status takes at most one run id", flags.json);
  }
  const resolved = await resolveContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const runId = rest[0];
  if (!runId) {
    const listed = await requestList(resolved.context, host);
    if (listed.kind === "request_error") {
      return failureFromRequestNotFoundAsUsage(listed.result, flags.json);
    }
    if (listed.kind === "invalid_response") {
      return unexpectedResponse(
        "unexpected validation list response from the CC server",
        flags.json,
      );
    }
    return renderActiveStatus(listed.value, flags.json);
  }
  const response = await cliRequest(host, {
    server: resolved.context.server,
    token: resolved.context.token,
    tokenSource: resolved.context.tokenSource,
    method: "GET",
    path: `${validationPath(resolved.context)}/${encodePathSegment(runId)}`,
  });
  if (response.kind !== "ok") {
    return failureFromRequestNotFoundAsUsage(response, flags.json);
  }
  const parsed = validationPollResponseSchema.safeParse(response.body);
  if (!parsed.success) {
    return unexpectedResponse(
      "unexpected validation status response from the CC server",
      flags.json,
    );
  }
  return renderOneStatus(parsed.data, flags.json);
}

async function runValidateCancel(
  rest: string[],
  passthrough: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const denied = checkFlags(values, "validate cancel", flags.json);
  if (denied) return denied;
  if (rest.length !== 1 || passthrough.length > 0) {
    return usageFailure(
      "validate cancel requires exactly one <run-id>",
      flags.json,
    );
  }
  const runId = rest[0];
  if (!runId)
    return usageFailure("validate cancel requires <run-id>", flags.json);
  const leaseFilePath = validationLeaseFilePath(runId, env, host);
  const leaseToken = (await host.readTextFile(leaseFilePath))?.trim();
  if (!leaseToken) {
    return usageFailure(
      `no submitter lease is stored for validation run ${runId}; cancel it from the cctl installation that submitted it`,
      flags.json,
    );
  }
  const resolved = await resolveContext(flags, env, host);
  if (!resolved.ok) return resolved.result;
  const response = await cancelOwnedRun(
    resolved.context,
    runId,
    leaseToken,
    host,
  );
  if (response.kind !== "ok") {
    return failureFromRequestNotFoundAsUsage(response, flags.json);
  }
  await removeStoredLease(leaseFilePath, host);
  return {
    exitCode: EXIT_OK,
    stdout: render(flags.json, `cancelled validation run ${runId}\n`, {
      ok: true,
      cancelled: true,
      runId,
    }),
    stderr: "",
  };
}
