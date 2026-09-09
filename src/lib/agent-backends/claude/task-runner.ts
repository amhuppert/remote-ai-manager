import { query } from "@anthropic-ai/claude-agent-sdk";
import { realpathSync } from "node:fs";
import path from "node:path";
import type {
  Options,
  SDKMessage,
  SDKResultSuccess,
  SDKResultError,
  SDKAssistantMessage,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { buildChildEnv } from "@/lib/shared/child-env";
import {
  buildSessionEnvContract,
  neutralizeAmbientCcEnv,
  type SessionEnv,
} from "@/lib/agent-gateway/session-env";
import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { getCachedInstanceToken } from "@/lib/agent-gateway/token";
import { getServerBaseUrl } from "@/lib/agent-gateway/server-url";
import { getConfigDirPath } from "@/lib/config/loader";
import { createLogger } from "@/lib/logging";
import {
  ccTaskSessionScopeSchema,
  type AgentTaskRequest,
  type AgentTaskResult,
  type AgentTaskRunner,
} from "../task";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import { translatePortableMcpToClaude } from "../mcp-translation";
import { appendStructuredOutputInstruction } from "../structured-output-prompt";
import {
  toRawTranscriptEntries,
  type AgentTranscriptEntry,
} from "../transcript";
// Prevent nested session detection when CC runs inside Claude Code
import "@/lib/shared/sdk-env";
import { getErrorMessage } from "@/lib/shared/errors";
import { createClaudeFailureClassifier } from "./failure-classifier";
import { createStallWatchdog } from "../stall-watchdog";
import { CLAUDE_DEFAULT_STALL_TIMEOUT_MS } from "./shared";
import { resolveClaudeManagedSkillsForLaunch } from "./managed-skills";
import {
  assertClaudeNativeMemoryNeutralized,
  CLAUDE_NATIVE_MEMORY_SETTINGS,
} from "./native-memory";
import { mapErrorSubtype } from "./process-message";
import {
  buildClaudeFsWriteEnvelope,
  type ClaudeFsWriteEnvelope,
} from "./fs-write-envelope";
import {
  resolveClaudeModelSelection,
  type ResolvedClaudeModelSelection,
} from "./model-selection";
import { ModelSelectionPolicyError } from "../model-selection";
import { providerRefDigest } from "../provider-ref-digest";

const logger = createLogger("claude:task-runner");
const claudeFailureClassifier = createClaudeFailureClassifier();

function isInsideOrEqual(ancestor: string, candidate: string): boolean {
  const relative = path.relative(
    path.resolve(ancestor),
    path.resolve(candidate),
  );
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

/**
 * A reviewer policy denies its entire candidate root, so that explicit deny
 * neutralizes Claude's writable-cwd default and relative inspection paths stay
 * useful. An implementer policy can deny only `.git` while allowing owned
 * prefixes inside the candidate; it must therefore use the policy's external
 * working root or cwd itself would reopen the whole worktree for writes.
 */
function resolveRestrictedWorkingDirectory(
  inputWorkingDirectory: string,
  restricted: ClaudeFsWriteEnvelope,
): string {
  let canonicalInputWorkingDirectory: string;
  try {
    canonicalInputWorkingDirectory = realpathSync(inputWorkingDirectory);
  } catch {
    canonicalInputWorkingDirectory = path.resolve(inputWorkingDirectory);
  }
  const inputRootIsDenied = restricted.sandbox.filesystem?.denyWrite?.some(
    (deniedPath) => isInsideOrEqual(deniedPath, canonicalInputWorkingDirectory),
  );
  return inputRootIsDenied
    ? inputWorkingDirectory
    : restricted.workingDirectory;
}

function resolveTaskContinuation(
  backendRef: AgentSessionRef | null,
  error: unknown | null,
): Pick<AgentTaskResult, "backendRef" | "failure" | "continuationDisposition"> {
  if (error === null) {
    return { backendRef, failure: null, continuationDisposition: "retain" };
  }
  const { failure, continuationDisposition } =
    claudeFailureClassifier.classifyWithContinuation(error);
  return {
    backendRef: continuationDisposition === "clear" ? null : backendRef,
    failure,
    continuationDisposition,
  };
}

// ============================================================
// Claude Task Runner
// ============================================================

/**
 * Provider port for the one SDK call the task runner makes. Injected so the
 * conformance suite can drive the real runner against a fake message stream;
 * the runner only iterates the returned stream, so the port is structural.
 */
export interface ClaudeTaskRunnerDeps {
  runQuery(args: {
    prompt: string;
    options: Options;
  }): AsyncIterable<SDKMessage>;
  /**
   * Server coordinates and config location for the session env and write
   * envelope contracts, read here (never from the request) so a scoped run
   * cannot be handed credentials or a network destination by its caller.
   */
  getServerUrl(): string | null;
  getApiToken(): string | null;
  getConfigDir(): string;
}

const defaultDeps: ClaudeTaskRunnerDeps = {
  runQuery: (args) => query(args),
  getServerUrl: getServerBaseUrl,
  getApiToken: getCachedInstanceToken,
  getConfigDir: getConfigDirPath,
};

export class ClaudeTaskRunner implements AgentTaskRunner {
  readonly backend: AgentBackendId = "claude";

  constructor(private readonly deps: ClaudeTaskRunnerDeps = defaultDeps) {}

  /**
   * Ambient CC_* (an outer instance's server URL/token, an outer lane's
   * workflow ids) is blanked FIRST, whether or not this run is scoped, so
   * nothing inherited can survive into the child. A run carrying a trusted
   * `ccSessionScope` then gets the full session env contract on top —
   * credentials and paths resolved here, server-side: the scope names an
   * identity, it never carries the means to act as one. An isolated one-shot
   * is hermetic by contract (spec `memory` R10) and gets no identity even
   * when a scope arrives.
   */
  private resolveChildEnv(
    input: AgentTaskRequest,
    isolatedOneShot: boolean,
    trustedServerUrl: string | null,
  ):
    | { kind: "resolved"; env: Record<string, string> }
    | { kind: "invalid_scope"; invalidFields: string } {
    const neutralizedEnv: SessionEnv = {
      ...neutralizeAmbientCcEnv(buildChildEnv()),
      ...(isolatedOneShot ? { CLAUDECODE: "" } : {}),
    };

    if (isolatedOneShot && input.ccSessionScope !== undefined) {
      // A scope on a hermetic run is a caller contradiction the profile wins:
      // no memory verb — ambient or explicit — may be reachable from it.
      logger.warn("claude-task-runner.session_scope_dropped", {
        workingDirectory: input.workingDirectory,
        executionProfile: "isolated-one-shot",
      });
    }
    if (input.ccSessionScope === undefined || isolatedOneShot) {
      return {
        kind: "resolved",
        env: neutralizedEnv as Record<string, string>,
      };
    }

    const scope = ccTaskSessionScopeSchema.safeParse(input.ccSessionScope);
    if (!scope.success) {
      // Field paths only — a scope value could be any string the caller built,
      // and this error travels into results and logs.
      return {
        kind: "invalid_scope",
        invalidFields: [
          ...new Set(scope.error.issues.map((issue) => issue.path.join("."))),
        ].join(", "),
      };
    }

    return {
      kind: "resolved",
      env: buildSessionEnvContract({
        baseEnv: neutralizedEnv,
        serverUrl: trustedServerUrl,
        apiToken: this.deps.getApiToken(),
        // The scope names a session-keyed identity, so it crosses into the
        // public target vocabulary through the one sanctioned adapter: a task
        // lane spawned from a project conversation carries the sentinel here,
        // and the target union is what keeps it out of CC_SESSION.
        target: targetFromStoreSessionName(
          scope.data.project,
          scope.data.session,
          scope.data.conversationId,
        ),
        configDir: this.deps.getConfigDir(),
      }) as Record<string, string>,
    };
  }

  async run(input: AgentTaskRequest): Promise<AgentTaskResult> {
    const isolatedOneShot = input.executionProfile === "isolated-one-shot";
    // A hermetic run never gets a CC identity, so a scope on it resolves no URL.
    const trustedServerUrl =
      input.fsWritePolicy !== undefined ||
      (input.ccSessionScope !== undefined && !isolatedOneShot)
        ? this.deps.getServerUrl()
        : null;

    let resolvedModelSelection: ResolvedClaudeModelSelection;
    try {
      resolvedModelSelection = resolveClaudeModelSelection(
        input.modelSelection,
      );
    } catch (cause) {
      const error = getErrorMessage(cause);
      logger.error("claude-task-runner.invalid_model_selection", {
        workingDirectory: input.workingDirectory,
        modelId: input.modelSelection.modelId,
        issues:
          cause instanceof ModelSelectionPolicyError ? cause.issues : null,
      });
      return {
        ...resolveTaskContinuation(
          input.resumeRef?.backend === "claude" ? input.resumeRef : null,
          error,
        ),
        text: null,
        usage: null,
        error,
        timedOut: false,
      };
    }

    logger.info("claude-task-runner.start", {
      workingDirectory: input.workingDirectory,
      hasResume: !!input.resumeRef,
      timeoutMs: input.timeoutMs,
      executionProfile: input.executionProfile ?? "standard",
      hasOutputSchema: input.outputSchema !== undefined,
      hasCcSessionScope: input.ccSessionScope !== undefined,
      fsWriteRestricted: input.fsWritePolicy !== undefined,
    });

    // Established before anything else this run does: a lane whose policy
    // cannot be translated onto the sandbox and the permission rules never
    // reaches the provider, so it can never run unrestricted. Unlike Codex,
    // this applies to the isolated one-shot profile too — the sandbox and the
    // rules only ever tighten what that profile already allows.
    const writeEnvelope =
      input.fsWritePolicy !== undefined
        ? buildClaudeFsWriteEnvelope(input.fsWritePolicy, trustedServerUrl)
        : null;
    if (writeEnvelope?.kind === "unestablishable") {
      const error = `Cannot establish the Claude filesystem write envelope: ${writeEnvelope.reason}`;
      logger.error("claude-task-runner.write_envelope_unestablishable", {
        workingDirectory: input.workingDirectory,
        reason: writeEnvelope.reason,
      });
      return {
        ...resolveTaskContinuation(null, error),
        text: null,
        usage: null,
        error,
        timedOut: false,
      };
    }
    const restricted =
      writeEnvelope?.kind === "envelope" ? writeEnvelope : null;
    const workingDirectory = restricted
      ? resolveRestrictedWorkingDirectory(
          input.workingDirectory,
          restricted.envelope,
        )
      : input.workingDirectory;
    if (workingDirectory !== input.workingDirectory) {
      logger.info("claude-task-runner.write_envelope_cwd_relocated", {
        requestedWorkingDirectory: input.workingDirectory,
        effectiveWorkingDirectory: workingDirectory,
      });
    }

    // Cannot resume a different backend's session
    if (
      !isolatedOneShot &&
      input.resumeRef != null &&
      input.resumeRef.backend !== "claude"
    ) {
      const error = `Cannot resume a ${input.resumeRef.backend} session with ClaudeTaskRunner`;
      logger.error("claude-task-runner.resume_backend_mismatch", {
        resumeBackend: input.resumeRef.backend,
      });
      return {
        ...resolveTaskContinuation(null, error),
        text: null,
        usage: null,
        error,
        timedOut: false,
      };
    }

    const resumeSessionId =
      !isolatedOneShot && input.resumeRef?.backend === "claude"
        ? input.resumeRef.ref
        : undefined;

    if (resumeSessionId) {
      logger.info("claude-task-runner.resume", {
        sessionIdDigest: providerRefDigest(resumeSessionId),
      });
    }

    // Log Codex-only fields that are non-default, since Claude ignores them
    const droppedFields: string[] = [];
    if (input.sandboxMode !== undefined) droppedFields.push("sandboxMode");
    if (input.approvalPolicy !== undefined)
      droppedFields.push("approvalPolicy");
    if (input.networkAccessEnabled !== undefined)
      droppedFields.push("networkAccessEnabled");
    if (input.webSearchMode !== undefined) droppedFields.push("webSearchMode");
    if (input.additionalDirectories?.length)
      droppedFields.push("additionalDirectories");
    if (input.skipGitRepoCheck !== undefined)
      droppedFields.push("skipGitRepoCheck");
    if (droppedFields.length > 0) {
      logger.warn("claude-task-runner.dropped_fields", {
        workingDirectory: input.workingDirectory,
        droppedFields,
      });
    }

    // Build MCP servers from tooling
    const mcpServers: Record<string, unknown> = {};

    if (!isolatedOneShot && input.tooling?.portableMcp) {
      const {
        servers: portableServers,
        rejectedServers,
        rejectedFields,
      } = translatePortableMcpToClaude(input.tooling.portableMcp);
      if (rejectedServers.length > 0) {
        logger.warn("claude-task-runner.rejected_portable_mcp_servers", {
          workingDirectory: input.workingDirectory,
          rejectedServers,
          rejectedFields,
        });
      }
      Object.assign(mcpServers, portableServers);
    }

    const systemPromptAppend = input.systemInstructions?.length
      ? input.systemInstructions.join("\n\n")
      : undefined;

    const prompt = input.outputSchema
      ? appendStructuredOutputInstruction(input.prompt, input.outputSchema)
      : input.prompt;

    const childEnv = this.resolveChildEnv(
      input,
      isolatedOneShot,
      trustedServerUrl,
    );
    if (childEnv.kind === "invalid_scope") {
      const error = `Invalid ccSessionScope for a Claude task run: ${childEnv.invalidFields}`;
      logger.error("claude-task-runner.invalid_session_scope", {
        workingDirectory: input.workingDirectory,
        invalidFields: childEnv.invalidFields,
      });
      return {
        ...resolveTaskContinuation(null, error),
        text: null,
        usage: null,
        error,
        timedOut: false,
      };
    }

    // Set up timeout via AbortController
    const abortController = new AbortController();
    let timedOut = false;

    // timeoutMs=0 means "no timeout" — skip the timer entirely
    const timeoutHandle =
      input.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            logger.warn("claude-task-runner.timeout", {
              workingDirectory: input.workingDirectory,
              timeoutMs: input.timeoutMs,
            });
            abortController.abort();
          }, input.timeoutMs)
        : null;

    // Fold an external cancellation signal into the same abort path so a
    // job-shaped caller can cancel a live run.
    const externalSignal = input.signal;
    const onExternalAbort = () => abortController.abort();
    if (externalSignal) {
      if (externalSignal.aborted) abortController.abort();
      else externalSignal.addEventListener("abort", onExternalAbort);
    }

    // Inactivity watchdog: unlike the whole-run timeout above, this only
    // trips on dead air — every streamed message resets it. A caller that
    // passes no bound gets the backend default rather than an unbounded run.
    const stallTimeoutMs =
      input.stallTimeoutMs ?? CLAUDE_DEFAULT_STALL_TIMEOUT_MS;
    const stallWatchdog = createStallWatchdog({
      stallTimeoutMs,
      onStall: () => {
        logger.warn("claude-task-runner.stalled", {
          workingDirectory: input.workingDirectory,
          stallTimeoutMs,
        });
        abortController.abort();
      },
    });

    let sessionId: string | null = null;
    const textBlocks: string[] = [];
    const rawMessages: unknown[] = [];
    let finalResponseText: string | undefined;
    let usageResult: AgentTaskResult["usage"] = null;
    let error: string | null = null;

    // Managed skill bundle: standard task runs get the same attachment as
    // conversations; the isolated one-shot profile is hermetic by contract.
    const managedSkills = isolatedOneShot
      ? { plugins: [], enabledPluginsOverride: {} }
      : await resolveClaudeManagedSkillsForLaunch();

    try {
      // The `settings` below are the SDK's FLAG tier, which managed policy
      // outranks. Confirm the native-memory neutralization survives the
      // cascade before spawning: with no lever above managed policy, a run
      // that started anyway would contradict the descriptor's `disabled`
      // claim. The refusal lands in the catch below and is reported as an
      // ordinary run failure (see ./native-memory.ts).
      await assertClaudeNativeMemoryNeutralized({ cwd: workingDirectory });

      const stream = this.deps.runQuery({
        prompt,
        options: {
          // A restricted TASK lane keeps its caller's working directory: its
          // policy denies the whole candidate worktree and allows nothing
          // inside it, so the sandbox's writable-cwd default is already
          // overridden by an explicit deny. A policy that allows part of the
          // tree it runs in cannot be confined that way and must run from
          // `envelope.workingDirectory` instead — see the conversation path.
          cwd: workingDirectory,
          systemPrompt: {
            type: "preset",
            preset: "claude_code",
            append: systemPromptAppend,
          },
          // A restricted lane drops the bypass entirely: with the file-mutation
          // tools scoped by rule, "deny anything not pre-approved" is what makes
          // an unanticipated mutation path fail instead of prompting into a
          // headless void.
          ...(restricted
            ? { permissionMode: restricted.envelope.permissionMode }
            : {
                permissionMode: "bypassPermissions" as const,
                allowDangerouslySkipPermissions: true,
              }),
          // No user, project, or local settings for a restricted lane: a
          // settings file committed into the candidate must not be able to
          // widen the permissions of the reviewer reading it.
          settingSources:
            isolatedOneShot || restricted ? [] : ["user", "project", "local"],
          ...(restricted ? { sandbox: restricted.envelope.sandbox } : {}),
          ...(managedSkills.plugins.length > 0
            ? { plugins: managedSkills.plugins }
            : {}),
          // Unconditional, unlike the keys around it: the native-memory
          // neutralization is what makes the descriptor's `disabled` claim
          // true for every launched task run, not only the ones that happen
          // to carry plugin or permission overrides (see ./native-memory.ts).
          settings: {
            ...CLAUDE_NATIVE_MEMORY_SETTINGS,
            ...(Object.keys(managedSkills.enabledPluginsOverride).length > 0
              ? { enabledPlugins: managedSkills.enabledPluginsOverride }
              : {}),
            ...(restricted
              ? { permissions: restricted.envelope.permissions }
              : {}),
          },
          ...(isolatedOneShot
            ? { maxTurns: 1, tools: [], strictMcpConfig: true }
            : {}),
          model: resolvedModelSelection.modelId,
          ...(resolvedModelSelection.effort
            ? { effort: resolvedModelSelection.effort as Options["effort"] }
            : {}),
          resume: resumeSessionId,
          persistSession: !isolatedOneShot,
          mcpServers: mcpServers as Record<string, never>,
          abortController,
          env: restricted
            ? {
                ...childEnv.env,
                CLAUDE_CODE_TMPDIR: restricted.envelope.tmpDir,
                TMPDIR: restricted.envelope.tmpDir,
              }
            : childEnv.env,
        },
      });

      for await (const message of stream) {
        stallWatchdog.touch();
        const msg = message as SDKMessage;
        rawMessages.push(message);

        if (msg.type === "system") {
          const sysMsg = msg as SDKSystemMessage;
          sessionId = sysMsg.session_id;
        } else if (msg.type === "assistant") {
          const asstMsg = msg as SDKAssistantMessage;
          sessionId = asstMsg.session_id;

          for (const block of asstMsg.message.content) {
            if (block.type === "text" && "text" in block) {
              textBlocks.push(block.text);
            }
          }
        } else if (msg.type === "result") {
          const resultMsg = msg as SDKResultSuccess | SDKResultError;
          sessionId = resultMsg.session_id;

          const usage = resultMsg.usage;
          usageResult = {
            inputTokens: usage.input_tokens,
            cachedInputTokens: usage.cache_read_input_tokens,
            outputTokens: usage.output_tokens,
          };

          if (resultMsg.subtype === "success") {
            finalResponseText =
              typeof resultMsg.result === "string"
                ? resultMsg.result
                : undefined;
          } else {
            const errMsg = resultMsg as SDKResultError;
            error = mapErrorSubtype(errMsg);
          }
        }
      }
    } catch (err) {
      if (!timedOut && !stallWatchdog.fired()) {
        error = getErrorMessage(err);
        logger.error("claude-task-runner.query_error", {
          workingDirectory: input.workingDirectory,
          error,
        });
      }
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      stallWatchdog.cancel();
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }

    const observedBackendRef =
      sessionId && !isolatedOneShot
        ? { backend: "claude" as const, ref: sessionId }
        : null;
    const priorBackendRef =
      !isolatedOneShot && input.resumeRef?.backend === "claude"
        ? input.resumeRef
        : null;
    const stalled = stallWatchdog.fired();
    if (stalled) timedOut = true;
    const finalError = stalled
      ? `Task stalled: no backend activity for ${stallTimeoutMs}ms`
      : (error ?? (timedOut ? "Task timed out" : null));
    const continuation = resolveTaskContinuation(
      observedBackendRef ?? priorBackendRef,
      finalError,
    );

    const transcript: AgentTranscriptEntry[] | undefined =
      rawMessages.length > 0
        ? toRawTranscriptEntries("claude", rawMessages)
        : undefined;

    logger.info("claude-task-runner.complete", {
      workingDirectory: input.workingDirectory,
      sessionIdDigest: providerRefDigest(sessionId),
      timedOut,
      hasError: !!error,
      executionProfile: input.executionProfile ?? "standard",
      usedFinalResponseText:
        input.outputSchema !== undefined && finalResponseText !== undefined,
    });

    const assistantText = textBlocks.length > 0 ? textBlocks.join("") : null;
    return {
      ...continuation,
      text:
        input.outputSchema !== undefined && finalResponseText !== undefined
          ? finalResponseText
          : assistantText,
      usage: usageResult,
      ...(transcript ? { transcript } : {}),
      error: finalError,
      timedOut,
    };
  }
}

export const claudeTaskRunner = new ClaudeTaskRunner();
