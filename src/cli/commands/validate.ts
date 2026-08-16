import path from "node:path";
import { resolveConfigDirFrom } from "@/lib/config/config-dir";
import {
  validationListResponseSchema,
  validationPollResponseSchema,
  validationSubmitResponseSchema,
  VALIDATION_LEASE_HEADER,
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
import { flagNamesFor } from "../help-registry";
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

const POLL_INTERVAL_MS = 1_000;

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

function humanLine(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
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
  const denied = checkFlags(values, flagNamesFor("validate list"), flags.json);
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
      hint: `run 'cctl validate run ${commandName} --wait' to queue it`,
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
      return {
        exitCode: EXIT_OK,
        stdout: render(
          json,
          `${humanLine(result.message)}instruction: ${result.message}\n`,
          {
            ok: true,
            status: "skipped_by_policy",
            code: "validation_policy_skipped",
            instruction: result.message,
          },
        ),
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
  scope: { requestedScope: ValidationScope; effectiveScope: ValidationScope },
): CliResult {
  let rendered: CliResult;
  switch (result.kind) {
    case "passed":
      rendered = {
        exitCode: EXIT_OK,
        stdout: render(json, humanLine(result.output), {
          ok: true,
          code: "validation_passed",
          ...result,
        }),
        stderr: "",
      };
      break;
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

async function pollToTerminal(
  context: ConversationTargetContext,
  runId: string,
  leaseToken: string,
  initialPosition: number | null,
  scope: { requestedScope: ValidationScope; effectiveScope: ValidationScope },
  json: boolean,
  host: CliHost,
): Promise<CliResult> {
  const queuePositions: number[] = [];
  reportQueuePosition(runId, initialPosition, queuePositions, json, host);
  let interrupted: "SIGINT" | "SIGTERM" | null = null;
  const removeSignalListener = host.onSignal?.((signal) => {
    interrupted = signal;
  });

  try {
    for (;;) {
      if (interrupted !== null) {
        const signal = interrupted;
        const cancelled = await cancelOwnedRun(
          context,
          runId,
          leaseToken,
          host,
        );
        if (cancelled.kind !== "ok") {
          return addProgress(
            failureFromRequest(cancelled, json),
            queuePositions,
            json,
            host,
          );
        }
        return addProgress(
          validationFailure(
            {
              exitCode: EXIT_OPERATION_FAILED,
              message: `Cancelled validation run ${runId} after ${signal}.`,
              code: "validation_cancelled_by_signal",
              json,
            },
            { runId, signal },
          ),
          queuePositions,
          json,
          host,
        );
      }

      const response = await cliRequest(host, {
        server: context.server,
        token: context.token,
        tokenSource: context.tokenSource,
        method: "GET",
        path: `${validationPath(context)}/${encodePathSegment(runId)}`,
        headers: { [VALIDATION_LEASE_HEADER]: leaseToken },
      });
      if (response.kind !== "ok") {
        return addProgress(
          failureFromRequestNotFoundAsUsage(response, json),
          queuePositions,
          json,
          host,
        );
      }
      const parsed = validationPollResponseSchema.safeParse(response.body);
      if (!parsed.success) {
        return addProgress(
          unexpectedResponse(
            "unexpected validation status response from the CC server",
            json,
          ),
          queuePositions,
          json,
          host,
        );
      }
      reportQueuePosition(
        runId,
        parsed.data.position,
        queuePositions,
        json,
        host,
      );
      if (parsed.data.result !== null) {
        const terminal = parsed.data.result;
        if (terminal.kind === "cost_exceeds_limit") {
          return addProgress(
            notStartedResult(terminal.name, terminal, json),
            queuePositions,
            json,
            host,
          );
        }
        if (
          terminal.kind === "passed" ||
          terminal.kind === "failed" ||
          terminal.kind === "timed_out" ||
          terminal.kind === "cancelled" ||
          terminal.kind === "interrupted"
        ) {
          return addProgress(
            terminalRunResult(terminal, json, scope),
            queuePositions,
            json,
            host,
          );
        }
        return addProgress(
          unexpectedResponse(
            `validation run ${runId} returned non-terminal result ${terminal.kind} from status`,
            json,
          ),
          queuePositions,
          json,
          host,
        );
      }
      await host.sleep(POLL_INTERVAL_MS);
    }
  } finally {
    removeSignalListener?.();
  }
}

async function runValidateRun(
  rest: string[],
  passthrough: string[],
  flags: GlobalFlags,
  values: Record<string, string>,
  env: CliEnv,
  host: CliHost,
): Promise<CliResult> {
  const denied = checkFlags(values, flagNamesFor("validate run"), flags.json);
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
  const wait = values["wait"] !== undefined;
  const response = await cliRequest(host, {
    server: resolved.context.server,
    token: resolved.context.token,
    tokenSource: resolved.context.tokenSource,
    method: "POST",
    path: validationPath(resolved.context),
    body: {
      commandName,
      scope: requestedScope,
      wait,
      ...(passthrough.length > 0 ? { scopePaths: passthrough } : {}),
      ...(env["CC_VALIDATION_RUN_ID"]
        ? { nestedValidationRunId: env["CC_VALIDATION_RUN_ID"] }
        : {}),
      ...(workflowExecutionId && workflowContextId
        ? { workflowExecutionId, workflowContextId }
        : {}),
    },
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
  if (!host.writePrivateTextFile) {
    await cancelOwnedRun(
      resolved.context,
      parsed.data.runId,
      parsed.data.lease.token,
      host,
    );
    return validationFailure({
      exitCode: EXIT_OPERATION_FAILED,
      message: "cctl cannot persist the private validation lease",
      detail: "The accepted validation run was cancelled before it started.",
      code: "validation_lease_store_failed",
      json: flags.json,
    });
  }
  try {
    await host.writePrivateTextFile(
      leaseFilePath,
      `${parsed.data.lease.token}\n`,
    );
  } catch {
    await cancelOwnedRun(
      resolved.context,
      parsed.data.runId,
      parsed.data.lease.token,
      host,
    );
    return validationFailure({
      exitCode: EXIT_OPERATION_FAILED,
      message: "cctl could not persist the private validation lease",
      detail: "The accepted validation run was cancelled before it started.",
      code: "validation_lease_store_failed",
      json: flags.json,
    });
  }
  try {
    return await pollToTerminal(
      resolved.context,
      parsed.data.runId,
      parsed.data.lease.token,
      parsed.data.position,
      {
        requestedScope: parsed.data.requestedScope,
        effectiveScope: parsed.data.effectiveScope,
      },
      flags.json,
      host,
    );
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
  const denied = checkFlags(
    values,
    flagNamesFor("validate status"),
    flags.json,
  );
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
  const denied = checkFlags(
    values,
    flagNamesFor("validate cancel"),
    flags.json,
  );
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
