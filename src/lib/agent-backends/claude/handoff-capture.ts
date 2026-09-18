import { createClaudeFailureClassifier } from "./failure-classifier";
import { randomUUID } from "node:crypto";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { CaptureOmissionReason } from "../schemas";
import { mapAssistantContentBlocks } from "./map-content-blocks";
import type {
  CaptureHandoffInput,
  CaptureHandoffResult,
} from "../conversation";
import { appendStructuredOutputInstruction } from "../structured-output-prompt";
import {
  createQuerySession,
  type QuerySession,
  type QuerySessionOptions,
} from "./query-session";

/** Capture is a private phase of the existing runtime, never an ordinary turn. */
export async function captureClaudeHandoff(
  input: CaptureHandoffInput,
  original: QuerySession,
  options: QuerySessionOptions,
  bind: (session: QuerySession) => void,
  ownSettlement: (work: Promise<void>) => void,
): Promise<CaptureHandoffResult> {
  const startedAt = Date.now();
  const remainingMs = () =>
    Math.max(1, input.limits.executionMs - (Date.now() - startedAt));
  const ref = options.resume
    ? { backend: "claude" as const, ref: options.resume }
    : null;
  const result: CaptureHandoffResult = {
    modeEstablished: false,
    submitted: false,
    correlatedCompletion: false,
    candidateText: null,
    omissionReason: "mode_establishment_failed",
    executionSettled: true,
    cleanupFailure: null,
    continuation: {
      disposition: ref ? "retain" : "clear",
      backendRef: ref,
      nextRuntime: ref ? "current" : "unavailable",
    },
    activity: {
      transport: "complete",
      native: "unavailable",
      prohibited: "not_observed",
      inspectedBytes: null,
    },
    usage: {
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      costUsd: null,
      costBasis: null,
      executionMs: null,
      settlementMs: null,
    },
  };
  const classifyFailure = (error: unknown) => {
    if (
      createClaudeFailureClassifier().classifyWithContinuation(error)
        .continuationDisposition === "clear"
    ) {
      result.continuation = {
        disposition: "clear",
        backendRef: null,
        nextRuntime: "unavailable",
      };
      return "continuity_unavailable" as const;
    }
    return "capture_failed" as const;
  };
  const omitBeforeSubmission = async (reason: CaptureOmissionReason) => {
    result.omissionReason = reason;
    if (options.checkpointCapture) {
      result.continuation.nextRuntime = ref
        ? "recreate_from_ref"
        : "unavailable";
      original.close();
      const settlement = original.awaitClosed();
      ownSettlement(settlement);
      try {
        await within(settlement, input.limits.settlementMs);
      } catch {
        result.executionSettled = false;
        result.cleanupFailure = {
          code: "cleanup_unverified",
          message: "Restricted startup collection could not be verified",
        };
      }
      const diagnostics = original.readCaptureDiagnostics();
      if (diagnostics) classifyFailure(diagnostics);
    }
    return result;
  };
  if (!ref) {
    return omitBeforeSubmission("continuity_unavailable");
  }
  if (input.mode !== "tool-disabled") {
    return omitBeforeSubmission("mode_changed");
  }
  const prompt = appendStructuredOutputInstruction(
    input.promptText,
    input.outputSchema,
  );
  if (Buffer.byteLength(prompt, "utf8") > input.limits.inputBytes) {
    return omitBeforeSubmission("input_limit");
  }
  if (input.signal.aborted) {
    return omitBeforeSubmission("cancelled");
  }
  if (original.isTurnActive) {
    return omitBeforeSubmission("unavailable");
  }
  let session = original;
  if (!options.checkpointCapture) {
    let controlRejected = false;
    let controlAcknowledged = false;
    const control = original.query
      .applyFlagSettings({ disableAllHooks: true })
      .then(
        () => {
          controlAcknowledged = true;
        },
        (error: unknown) => {
          controlRejected = true;
          throw error;
        },
      );
    try {
      await within(control, remainingMs(), input.signal);
    } catch {
      if (input.signal.aborted) result.omissionReason = "cancelled";
      if (!controlRejected && !controlAcknowledged) {
        // A timeout does not cancel the SDK request. Only its ACK permits close;
        // until then the runtime must remain owned and cannot serve ordinary turns.
        result.executionSettled = false;
        result.activity.transport = "incomplete";
        result.continuation.nextRuntime = "recreate_from_ref";
        result.cleanupFailure = {
          code: "cleanup_unverified",
          message: "Hook suppression acknowledgement remains unresolved",
        };
        const settlement = control.then(async () => {
          original.close();
          await original.awaitClosed();
        });
        ownSettlement(settlement);
        // Ownership retains rejection for reconciliation without an unhandled promise.
        void settlement.catch(() => {});
      }
      if (!controlAcknowledged) return result;
    }
    original.close();
    result.continuation.nextRuntime = "recreate_from_ref";
    try {
      await within(original.awaitClosed(), input.limits.settlementMs);
    } catch {
      result.executionSettled = false;
      result.omissionReason = "cleanup_unverified";
      result.cleanupFailure = {
        code: "cleanup_unverified",
        message: "Source transport collection could not be verified",
      };
      return result;
    }
    if (
      input.signal.aborted ||
      Date.now() - startedAt >= input.limits.executionMs
    ) {
      result.omissionReason = input.signal.aborted
        ? "cancelled"
        : "execution_limit";
      return result;
    }
    try {
      session = createQuerySession({
        ...options,
        checkpointCapture: true,
        externalTurnHandler: undefined,
        onBackgroundActivity: undefined,
        onBackgroundTasksLost: undefined,
      });
    } catch {
      return result;
    }
    bind(session);
  }
  const uuid = randomUUID();
  let candidate: string | null = null;
  let terminalFailure: string | null = null;
  let costBaseline = 0;
  let seq = 0;
  let audit = Promise.resolve();
  let auditFailed = false;
  let omission: CaptureOmissionReason | null = null;
  const stop = (reason: CaptureOmissionReason) => {
    omission ??= reason;
    session.interruptCapture();
  };
  const record = (message: SDKMessage, control = false) => {
    const type = control
      ? "user"
      : message.type === "user"
        ? "tool_result"
        : message.type;
    const entry = {
      seq: seq++,
      backend: "claude" as const,
      type,
      raw: {
        timestamp: new Date().toISOString(),
        type,
        raw: message,
        ...(message.type === "assistant"
          ? {
              role: "assistant",
              uuid: message.uuid,
              content: mapAssistantContentBlocks(message.message.content),
            }
          : {}),
      },
    };
    audit = audit
      .then(() => input.onTranscript(entry))
      .catch(() => {
        auditFailed = true;
        stop("capture_failed");
      });
  };
  const answerBytes = new Map<string, number>();
  const seenFragments = new Set<string>();
  let streamId = "";
  const count = (id: string, bytes: number, append = false) => {
    answerBytes.set(
      id,
      append
        ? (answerBytes.get(id) ?? 0) + bytes
        : Math.max(answerBytes.get(id) ?? 0, bytes),
    );
    if (
      [...answerBytes.values()].reduce((sum, value) => sum + value, 0) >
      input.limits.outputBytes
    )
      stop("output_limit");
  };
  const observe = (message: SDKMessage) => {
    record(message);
    if (message.session_id !== ref.ref) {
      result.modeEstablished = false;
      stop("mode_establishment_failed");
      return;
    }
    if (message.type === "system" && message.subtype === "init") {
      result.modeEstablished =
        message.tools.length === 0 &&
        message.mcp_servers.length === 0 &&
        message.plugins.length === 0;
      if (!result.modeEstablished) stop("mode_establishment_failed");
    }
    if (message.type === "stream_event") {
      const event = message.event;
      if (
        event.type === "message_delta" &&
        event.delta.stop_reason === "max_tokens"
      )
        stop("output_limit");
      if (event.type === "message_start") streamId = event.message.id;
      if (
        event.type === "content_block_start" &&
        ["tool_use", "server_tool_use"].includes(event.content_block.type)
      ) {
        result.activity.prohibited = "observed";
        stop("prohibited_activity");
      }
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta" &&
        !seenFragments.has(message.uuid)
      ) {
        seenFragments.add(message.uuid);
        count(streamId, Buffer.byteLength(event.delta.text, "utf8"), true);
      }
    }
    if (message.type === "assistant") {
      if (message.message.stop_reason === "max_tokens") stop("output_limit");
      if (
        message.message.content.some((block) =>
          ["tool_use", "server_tool_use"].includes(block.type),
        )
      ) {
        result.activity.prohibited = "observed";
        stop("prohibited_activity");
      }
      const text = message.message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("");
      count(message.message.id, Buffer.byteLength(text, "utf8"));
    }
    if (message.type === "result" && message.user_message_uuid !== uuid) {
      if (Number.isFinite(message.total_cost_usd))
        costBaseline = message.total_cost_usd;
    }
    if (message.type === "result" && message.user_message_uuid === uuid) {
      result.correlatedCompletion = true;
      if (message.subtype !== "success")
        terminalFailure = message.errors.join("\n");
      else if (message.is_error) terminalFailure = message.result;
      const measured = (value: unknown) =>
        typeof value === "number" && Number.isFinite(value) && value >= 0
          ? value
          : null;
      const success = message.subtype === "success" && !message.is_error;
      const cost = measured(message.total_cost_usd);
      if (cost !== null && (success || cost > 0)) {
        result.usage.costUsd = Math.max(0, cost - costBaseline);
        result.usage.costBasis = "provider_reported";
      }
      if (success) {
        result.usage.inputTokens = measured(message.usage?.input_tokens);
        result.usage.outputTokens = measured(message.usage?.output_tokens);
        result.usage.cachedInputTokens = measured(
          message.usage?.cache_read_input_tokens,
        );
      } else {
        // Error results may zero the per-turn counters after an actual inference.
        const models = Object.values(message.modelUsage ?? {});
        const sum = (
          key: "inputTokens" | "outputTokens" | "cacheReadInputTokens",
        ) => {
          const values = models.map((model) => measured(model[key]));
          return values.length === 0 || values.some((value) => value === null)
            ? null
            : values.reduce<number>((total, value) => total + (value ?? 0), 0);
        };
        const inputTokens = sum("inputTokens");
        const outputTokens = sum("outputTokens");
        if ((inputTokens ?? 0) + (outputTokens ?? 0) > 0) {
          result.usage.inputTokens = inputTokens;
          result.usage.outputTokens = outputTokens;
          result.usage.cachedInputTokens = sum("cacheReadInputTokens");
        }
      }
      if (!result.modeEstablished) stop("mode_establishment_failed");
      if (
        message.subtype === "success" &&
        Buffer.byteLength(message.result, "utf8") > input.limits.outputBytes
      )
        stop("output_limit");
    }
  };
  session.observeCapture(observe);
  const onAbort = () => stop("cancelled");
  input.signal.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => stop("execution_limit"), remainingMs());
  result.continuation.nextRuntime = "recreate_from_ref";
  try {
    record(
      {
        type: "user",
        uuid,
        session_id: ref.ref,
        parent_tool_use_id: null,
        message: { role: "user", content: prompt },
      },
      true,
    );
    await within(audit, remainingMs());
    if (input.signal.aborted) stop("cancelled");
    if (!omission) {
      result.submitted = true;
      const turn = await session.sendPrompt(prompt, () => {}, {
        captureInputUuid: uuid,
      });
      if (turn.error) {
        const failureReason = classifyFailure(turn.error);
        omission ??= failureReason;
      } else if (turn.finalText) candidate = turn.finalText;
      else omission ??= "invalid_output";
    }
  } catch (error) {
    const failureReason = classifyFailure(error);
    omission ??= failureReason;
  } finally {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", onAbort);
    result.usage.executionMs = Date.now() - startedAt;
    const settlementStarted = Date.now();
    session.close();
    const settlement = session
      .awaitClosed()
      .then(() => audit)
      .then(() => {
        session.observeCapture(null);
        if (auditFailed) throw new Error("Required capture audit failed");
      });
    ownSettlement(settlement);
    try {
      await within(settlement, input.limits.settlementMs);
      result.executionSettled = true;
    } catch {
      result.executionSettled = false;
    }
    result.usage.settlementMs = Date.now() - settlementStarted;
  }
  // A stop reason describes why capture was omitted, not whether its source
  // still exists. Closing rejects the pending turn before stderr necessarily
  // drains, so assess collected diagnostics independently before publishing.
  for (const evidence of [terminalFailure, session.readCaptureDiagnostics()]) {
    if (!evidence) continue;
    const failureReason = classifyFailure(evidence);
    if (failureReason === "continuity_unavailable") omission ??= failureReason;
  }
  result.activity.transport =
    auditFailed || !result.executionSettled ? "incomplete" : "complete";
  if (!result.executionSettled) {
    result.cleanupFailure = {
      code: "cleanup_unverified",
      message:
        "Capture child, pump or required audit collection could not be verified",
    };
    omission ??= "cleanup_unverified";
  }
  result.omissionReason = omission;
  if (
    !omission &&
    result.modeEstablished &&
    result.correlatedCompletion &&
    result.executionSettled
  )
    result.candidateText = candidate;
  if (result.candidateText === null) result.omissionReason ??= "capture_failed";

  // The owned observer may keep draining after a cleanup timeout. Its private
  // measurements must not mutate the outcome already returned to the manager.
  return structuredClone(result);
}

async function within<T>(
  work: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("controls_unavailable")), ms);
        onAbort = () => reject(new Error("capture_cancelled"));
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

export async function collectClaudeCaptureSessions(
  sessions: Iterable<QuerySession>,
  graceMs: number,
  barriers: Iterable<Promise<void>>,
  activeAttempt: Promise<CaptureHandoffResult> | null,
): Promise<void> {
  await within(
    (async () => {
      // Capture may still be installing its control or audit barriers.
      const result = await activeAttempt;
      if (result?.continuation.nextRuntime === "current") {
        throw new Error(
          "Capture did not authorize closing the unchanged source Query",
        );
      }
      // A pending pre-close control is itself an ownership barrier. Never close
      // an unacknowledged source merely because the caller requests cleanup.
      await Promise.all(barriers);
      const owned = [...sessions];
      for (const session of owned) session.close();
      await Promise.all(owned.map((session) => session.awaitClosed()));
    })(),
    graceMs,
  );
}
