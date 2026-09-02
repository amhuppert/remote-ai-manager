import { Codex } from "@openai/codex-sdk";
import type { CodexOptions, ThreadOptions } from "@openai/codex-sdk";
import { buildChildEnv } from "@/lib/shared/child-env";
import {
  buildSessionEnvContract,
  neutralizeAmbientCcEnv,
  type SessionEnv,
} from "@/lib/agent-gateway/session-env";
import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { getCachedInstanceToken } from "@/lib/agent-gateway/token";
import { getServerBaseUrl } from "@/lib/agent-gateway/server-url";
import { createLogger } from "@/lib/logging";
import {
  ccTaskSessionScopeSchema,
  type AgentTaskRequest,
  type AgentTaskResult,
  type AgentTaskRunner,
} from "../task";
import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import {
  toRawTranscriptEntries,
  type AgentTranscriptEntry,
} from "../transcript";
import { translatePortableMcpToCodex } from "./mcp-translation";
import {
  buildCodexMcpServersConfig,
  listNativeCodexMcpServers,
  type NativeCodexMcpServer,
} from "./native-mcp-suppression";
import { type CodexPricingTable } from "@/lib/agent-backends/schemas";
import { getConfigDirPath, readConfig } from "@/lib/config/loader";
import {
  estimateCodexCostUsd,
  resolveConfiguredCodexPricingOverrides,
} from "./pricing";
import {
  CODEX_DEFAULT_STALL_TIMEOUT_MS,
  toSdkModelReasoningEffort,
  toStringEnv,
} from "./shared";
import {
  resolveCodexStructuredOutput,
  type CodexPromptInput,
} from "./output-schema";
import { createStallWatchdog } from "../stall-watchdog";
import { getErrorMessage } from "@/lib/shared/errors";
import { createCodexFailureClassifier } from "./failure-classifier";
import { withCodexFastMode } from "./fast-mode-config";
import {
  ensureCodexManagedSkillsBridgeForLaunch,
  type CodexManagedSkillsBridgeResult,
} from "./managed-skills-bridge";
import { buildCodexFsWriteEnvelope } from "./fs-write-envelope";
import {
  projectAdmittedCodexModelSelection,
  type ResolvedCodexModelSelection,
} from "./model-selection";
import { ModelSelectionPolicyError } from "../model-selection";

const logger = createLogger("codex:task-runner");
const codexFailureClassifier = createCodexFailureClassifier();

const ISOLATED_ONE_SHOT_CODEX_FEATURES = {
  apps: false,
  auth_elicitation: false,
  browser_use: false,
  browser_use_external: false,
  browser_use_full_cdp_access: false,
  code_mode: false,
  code_mode_host: false,
  code_mode_only: false,
  computer_use: false,
  deferred_executor: false,
  enable_fanout: false,
  enable_mcp_apps: false,
  goals: false,
  hooks: false,
  image_generation: false,
  in_app_browser: false,
  js_repl: false,
  js_repl_tools_only: false,
  memories: false,
  memory_tool: false,
  multi_agent: false,
  multi_agent_mode: false,
  multi_agent_v2: false,
  plugin_sharing: false,
  plugins: false,
  remote_plugin: false,
  request_permissions: false,
  request_permissions_tool: false,
  search_tool: false,
  shell_tool: false,
  skill_mcp_dependency_install: false,
  standalone_web_search: false,
  tool_call_mcp_elicitation: false,
  tool_search: false,
  tool_suggest: false,
  unified_exec: false,
  web_search: false,
  web_search_cached: false,
  web_search_request: false,
  workspace_dependencies: false,
} as const;

function classifiedContinuation(
  backendRef: AgentSessionRef | null,
  error: unknown,
): Pick<AgentTaskResult, "backendRef" | "failure" | "continuationDisposition"> {
  const { failure, continuationDisposition } =
    codexFailureClassifier.classifyWithContinuation(error);
  return {
    backendRef: continuationDisposition === "clear" ? null : backendRef,
    failure,
    continuationDisposition,
  };
}

interface CodexTurnUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
}

interface CodexTaskTurn {
  finalResponse?: string;
  items?: unknown[];
  usage?: CodexTurnUsage | null;
  error?: string | null;
}

interface CodexTaskThread {
  readonly id: string | null;
  run(
    input: CodexTaskInput,
    options?: { outputSchema?: unknown; signal?: AbortSignal },
  ): Promise<CodexTaskTurn>;
  runStreamed?(
    input: CodexTaskInput,
    options?: { outputSchema?: unknown; signal?: AbortSignal },
  ): Promise<{ events: AsyncIterable<unknown> }>;
}

type CodexTaskInput = CodexPromptInput;

interface CodexTaskRunnerClient {
  startThread(options?: ThreadOptions): CodexTaskThread;
  resumeThread(id: string, options?: ThreadOptions): CodexTaskThread;
}

export interface CodexTaskRunnerDeps {
  createCodex(options: CodexOptions): CodexTaskRunnerClient;
  buildChildEnv(): NodeJS.ProcessEnv;
  listNativeCodexMcpServers(input: {
    cwd: string;
    env: Record<string, string>;
  }): Promise<NativeCodexMcpServer[]>;
  /** Per-model rate overrides from the Codex backend profile; null when unset. */
  getCodexPricingOverrides(): Promise<CodexPricingTable | null>;
  /**
   * Server coordinates and config location for the session env contract, read
   * here (never from the request) so a scoped run cannot be handed credentials
   * by its caller. Only consulted for a run carrying a `ccSessionScope`.
   */
  getServerUrl(): string | null;
  getApiToken(): string | null;
  getConfigDir(): string;
  /** Reconciles the managed skill bundle link in the launch checkout. */
  ensureManagedSkillsBridge(
    checkoutPath: string,
  ): Promise<CodexManagedSkillsBridgeResult>;
}

const defaultDeps: CodexTaskRunnerDeps = {
  createCodex: (options) =>
    new Codex(options) as unknown as CodexTaskRunnerClient,
  buildChildEnv,
  listNativeCodexMcpServers,
  getCodexPricingOverrides: async () =>
    resolveConfiguredCodexPricingOverrides(await readConfig()),
  getServerUrl: getServerBaseUrl,
  getApiToken: getCachedInstanceToken,
  getConfigDir: getConfigDirPath,
  ensureManagedSkillsBridge: ensureCodexManagedSkillsBridgeForLaunch,
};

/**
 * Governing instructions as Codex's privileged channel takes them, or undefined
 * when the run governs nothing.
 *
 * `developer_instructions` emits at the developer role, above user input, which
 * is what R10 requires of a role contract: it is never delivered as inline
 * user-prompt text while this channel exists. The fenced "## System
 * Instructions" block this replaced sat at user priority and was, on top of
 * that, terminable by a fence in any text it carried.
 */
function developerInstructions(input: AgentTaskRequest): string | undefined {
  return input.systemInstructions?.length
    ? input.systemInstructions.join("\n\n")
    : undefined;
}

/**
 * A restricted run executes from its own scratch directory rather than from the
 * directory it is reasoning about, so the subject has to be named absolutely —
 * a relative path would silently resolve inside the scratch dir.
 */
function workspaceNotice(worktreePath: string): string {
  return `The directory under review is ${worktreePath}. Address it by absolute path: your working directory is elsewhere and is the only place you can write.`;
}

function buildPrompt(
  input: AgentTaskRequest,
  relocatedFromWorktree: boolean,
): CodexTaskInput {
  const prompt = relocatedFromWorktree
    ? `${workspaceNotice(input.workingDirectory)}\n\n${input.prompt}`
    : input.prompt;
  if (!input.imagePaths?.length) return prompt;
  return [
    { type: "text", text: prompt },
    ...input.imagePaths.map((path) => ({ type: "local_image" as const, path })),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function eventMessage(value: unknown): string | null {
  if (!isRecord(value)) return null;
  const message = value.message;
  return typeof message === "string" ? message : null;
}

async function runCodexTurn(
  thread: CodexTaskThread,
  prompt: CodexTaskInput,
  options: {
    outputSchema?: unknown;
    signal?: AbortSignal;
    onActivity?: () => void;
  },
): Promise<CodexTaskTurn> {
  if (typeof thread.runStreamed !== "function") {
    return thread.run(prompt, options);
  }

  const streamed = await thread.runStreamed(prompt, options);
  const items: unknown[] = [];
  let finalResponse = "";
  let usage: CodexTurnUsage | null = null;
  let error: string | null = null;

  for await (const event of streamed.events) {
    options.onActivity?.();
    if (!isRecord(event) || typeof event.type !== "string") continue;

    if (event.type === "item.completed") {
      const item = event.item;
      items.push(item);
      if (
        isRecord(item) &&
        item.type === "agent_message" &&
        typeof item.text === "string"
      ) {
        finalResponse = item.text;
      }
      continue;
    }

    if (event.type === "turn.completed") {
      usage = isRecord(event.usage)
        ? (event.usage as unknown as CodexTurnUsage)
        : null;
      continue;
    }

    if (event.type === "turn.failed") {
      error = eventMessage(event.error) ?? "Codex turn failed";
      break;
    }

    if (event.type === "error") {
      error = eventMessage(event) ?? "Codex stream failed";
      break;
    }
  }

  return { items, finalResponse, usage, error };
}

// ============================================================
// Codex Task Runner
// ============================================================

export class CodexTaskRunner implements AgentTaskRunner {
  readonly backend: AgentBackendId = "codex";

  constructor(private readonly deps: CodexTaskRunnerDeps = defaultDeps) {}

  async run(input: AgentTaskRequest): Promise<AgentTaskResult> {
    const isolatedOneShot = input.executionProfile === "isolated-one-shot";

    let resolvedModelSelection: ResolvedCodexModelSelection;
    try {
      resolvedModelSelection = projectAdmittedCodexModelSelection(
        input.modelSelection,
      );
    } catch (cause) {
      const error = getErrorMessage(cause);
      logger.error("codex-task-runner.invalid_model_selection", {
        workingDirectory: input.workingDirectory,
        modelId: input.modelSelection.modelId,
        issues:
          cause instanceof ModelSelectionPolicyError ? cause.issues : null,
      });
      return {
        ...classifiedContinuation(
          !isolatedOneShot && input.resumeRef?.backend === "codex"
            ? input.resumeRef
            : null,
          error,
        ),
        text: null,
        usage: null,
        error,
        timedOut: false,
      };
    }

    // The isolated one-shot profile is already read-only, which forbids strictly
    // more than any allowlist can: a policy on such a run is satisfied by
    // leaving it alone, and translating it would WIDEN the run to
    // workspace-write. So the write envelope governs only the runs that are
    // otherwise write-capable.
    const writeEnvelope =
      input.fsWritePolicy !== undefined && !isolatedOneShot
        ? buildCodexFsWriteEnvelope(input.fsWritePolicy)
        : null;
    const unestablishableReason =
      writeEnvelope === null
        ? null
        : writeEnvelope.kind === "unestablishable"
          ? writeEnvelope.reason
          : // Two contradictions the adapter refuses rather than resolves. Both
            // widen workspace-write beyond the allowlist — full disk access
            // outright, extra directories by joining the writable workspace —
            // and a lane that cannot establish its envelope as written never
            // runs on a guess about which half the caller meant.
            input.sandboxMode === "danger-full-access"
            ? "the run asks for full disk access"
            : input.additionalDirectories?.length
              ? "the run asks for writable directories outside the allowlist"
              : null;
    if (unestablishableReason !== null) {
      const reason = unestablishableReason;
      const error = `Cannot establish the Codex filesystem write envelope: ${reason}`;
      logger.error("codex-task-runner.write_envelope_unestablishable", {
        workingDirectory: input.workingDirectory,
        reason,
      });
      return {
        ...classifiedContinuation(null, error),
        text: null,
        usage: null,
        error,
        timedOut: false,
      };
    }
    const restricted =
      writeEnvelope?.kind === "envelope" ? writeEnvelope : null;

    const threadOptions: ThreadOptions = {
      workingDirectory:
        restricted?.envelope.workingDirectory ?? input.workingDirectory,
      sandboxMode: isolatedOneShot
        ? "read-only"
        : restricted
          ? "workspace-write"
          : (input.sandboxMode ?? "danger-full-access"),
      approvalPolicy: isolatedOneShot
        ? "never"
        : (input.approvalPolicy ?? "never"),
      webSearchMode: isolatedOneShot
        ? "disabled"
        : (input.webSearchMode ?? "disabled"),
      skipGitRepoCheck: input.skipGitRepoCheck ?? true,
      ...(isolatedOneShot
        ? { networkAccessEnabled: false }
        : input.networkAccessEnabled !== undefined
          ? { networkAccessEnabled: input.networkAccessEnabled }
          : {}),
      ...(!isolatedOneShot && input.additionalDirectories
        ? { additionalDirectories: input.additionalDirectories }
        : {}),
      // Always pin a model. With no model the Codex SDK falls back to its own
      // built-in default, which is rejected for ChatGPT-account auth.
      model: resolvedModelSelection.modelId,
      modelReasoningEffort: toSdkModelReasoningEffort(
        resolvedModelSelection.reasoningEffort,
      ),
    };

    logger.info("codex-task-runner.start", {
      workingDirectory: input.workingDirectory,
      hasResume: !isolatedOneShot && !!input.resumeRef,
      timeoutMs: input.timeoutMs,
      sandboxMode: threadOptions.sandboxMode,
      approvalPolicy: threadOptions.approvalPolicy,
      webSearchMode: threadOptions.webSearchMode,
      skipGitRepoCheck: threadOptions.skipGitRepoCheck,
      executionProfile: input.executionProfile ?? "standard",
      hasCcSessionScope: input.ccSessionScope !== undefined,
      modelId: resolvedModelSelection.modelId,
      fastMode: resolvedModelSelection.fastMode,
      fsWriteRestricted: restricted !== null,
    });

    if (
      !isolatedOneShot &&
      input.resumeRef != null &&
      input.resumeRef.backend !== "codex"
    ) {
      const error = `Cannot resume a ${input.resumeRef.backend} session with CodexTaskRunner`;
      logger.error("codex-task-runner.resume_backend_mismatch", {
        resumeBackend: input.resumeRef.backend,
      });
      return {
        ...classifiedContinuation(null, error),
        text: null,
        usage: null,
        error,
        timedOut: false,
      };
    }

    // Ambient CC_* (an outer instance's server URL/token, an outer lane's
    // workflow ids) is blanked FIRST, whether or not this run is scoped, so
    // nothing inherited can survive into the child. Copy before neutralizing —
    // the helper mutates, and an injected dep may hand out a shared object.
    const neutralizedEnv: SessionEnv = {
      ...neutralizeAmbientCcEnv({ ...this.deps.buildChildEnv() }),
      CLAUDECODE: "",
      // The sandbox excludes the inherited temp roots, so a run that kept the
      // ambient TMPDIR would have a temp directory it cannot write to.
      ...(restricted ? { TMPDIR: restricted.envelope.tmpDir } : {}),
    };

    let sessionEnv = neutralizedEnv;
    if (input.ccSessionScope !== undefined) {
      const scope = ccTaskSessionScopeSchema.safeParse(input.ccSessionScope);
      if (!scope.success) {
        // Field paths only — a scope value could be any string the caller
        // built, and this error travels into results and logs.
        const invalidFields = [
          ...new Set(scope.error.issues.map((issue) => issue.path.join("."))),
        ].join(", ");
        const error = `Invalid ccSessionScope for a Codex task run: ${invalidFields}`;
        logger.error("codex-task-runner.invalid_session_scope", {
          workingDirectory: input.workingDirectory,
          invalidFields,
        });
        return {
          ...classifiedContinuation(null, error),
          text: null,
          usage: null,
          error,
          timedOut: false,
        };
      }
      // Credentials and paths are resolved here, server-side: the scope names
      // an identity, it never carries the means to act as one.
      sessionEnv = buildSessionEnvContract({
        baseEnv: neutralizedEnv,
        serverUrl: this.deps.getServerUrl(),
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
      });
    }
    const env = toStringEnv(sessionEnv);
    const abortController = new AbortController();
    const externalSignal = input.signal;
    const onExternalAbort = () => abortController.abort();
    if (externalSignal) {
      if (externalSignal.aborted) abortController.abort();
      else externalSignal.addEventListener("abort", onExternalAbort);
    }

    const codexFastMode = resolvedModelSelection.fastMode;
    logger.debug("codex-task-runner.fast_mode_resolved", {
      workingDirectory: input.workingDirectory,
      codexFastMode,
      source: "model_selection",
    });

    let mcpServersConfig: Record<string, unknown> | undefined;
    // A restricted lane gets the same treatment as the isolated profile: only
    // servers CC composed are reachable, so nothing the machine happens to have
    // configured can hand the lane a tool outside the envelope.
    if (isolatedOneShot || restricted) {
      const nativeServers = await listNativeMcpServers(
        input.workingDirectory,
        env,
        this.deps,
      );
      mcpServersConfig = buildCodexMcpServersConfig({
        managedMcpServers: {},
        nativeServers,
      });
      logger.info("codex-task-runner.mcp_config", {
        serverCount: Object.keys(mcpServersConfig).length,
        managedServerCount: 0,
        disabledNativeServerCount: Object.keys(mcpServersConfig).length,
      });
    } else if (input.tooling?.portableMcp) {
      const translated = translatePortableMcpToCodex(input.tooling.portableMcp);
      if (translated.droppedFields.length > 0) {
        logger.warn("codex-task-runner.mcp_dropped_fields", {
          droppedFields: translated.droppedFields,
        });
      }
      const nativeServers = await listNativeMcpServers(
        input.workingDirectory,
        env,
        this.deps,
      );
      mcpServersConfig = buildCodexMcpServersConfig({
        managedMcpServers: translated.mcpServers,
        nativeServers,
      });
      logger.info("codex-task-runner.mcp_config", {
        serverCount: Object.keys(mcpServersConfig).length,
        managedServerCount: Object.keys(translated.mcpServers).length,
        disabledNativeServerCount:
          Object.keys(mcpServersConfig).length -
          Object.keys(translated.mcpServers).length,
      });
    }

    const baseConfig = isolatedOneShot
      ? {
          apps: { _default: { enabled: false } },
          developer_instructions: "",
          features: ISOLATED_ONE_SHOT_CODEX_FEATURES,
          history: { persistence: "none" },
          include_apps_instructions: false,
          include_collaboration_mode_instructions: false,
          include_environment_context: false,
          include_permissions_instructions: false,
          memories: {
            dedicated_tools: false,
            generate_memories: false,
            use_memories: false,
          },
          mcp_servers: mcpServersConfig ?? {},
          project_doc_fallback_filenames: [],
          project_doc_max_bytes: 0,
          skills: {
            bundled: { enabled: false },
            include_instructions: false,
          },
        }
      : restricted
        ? {
            ...restricted.envelope.config,
            mcp_servers: mcpServersConfig ?? {},
          }
        : mcpServersConfig !== undefined
          ? { mcp_servers: mcpServersConfig }
          : undefined;
    // Managed skill bundle bridge: standard task runs reconcile the same
    // namespaced link as conversations; the isolated one-shot profile is
    // hermetic by contract. A conflict degrades to skill-less, never a
    // failed run.
    //
    // A restricted lane is skipped for a different reason than the isolated
    // profile: the bridge materializes a symlink INSIDE the checkout, and this
    // lane's whole contract is that the directory it reviews comes out of the
    // run exactly as it went in. Skill-less is the correct trade — the
    // alternative is a reviewer whose own launch path writes to the candidate.
    // (Claude has no equivalent skip: its bundle attaches as a plugin option
    // and never touches the checkout.)
    if (!isolatedOneShot && !restricted) {
      const bridgeResult = await this.deps.ensureManagedSkillsBridge(
        input.workingDirectory,
      );
      if (bridgeResult.status === "conflict") {
        logger.warn("codex-task-runner.managed_skills_degraded", {
          workingDirectory: input.workingDirectory,
          detail: bridgeResult.detail,
        });
      }
    }

    // Layered LAST so it wins over the isolated-one-shot blank: that blank
    // drops AMBIENT developer instructions, and a payload the caller supplied
    // for this run is the opposite of ambient. The override rides the client
    // config, so it applies to a resumed thread exactly as to a fresh one.
    const developerPayload = developerInstructions(input);
    const codexOptions: CodexOptions = {
      env,
      config: withCodexFastMode(
        {
          ...(baseConfig as CodexOptions["config"]),
          ...(developerPayload !== undefined
            ? { developer_instructions: developerPayload }
            : {}),
        },
        codexFastMode,
      ),
    };

    const authoredPrompt = buildPrompt(input, restricted !== null);
    const structured = input.outputSchema
      ? resolveCodexStructuredOutput(input.outputSchema)
      : null;
    if (structured?.transport === "prompt_contract") {
      logger.info("codex-task-runner.structured_output_prompt_contract", {
        workingDirectory: input.workingDirectory,
        reason: structured.reason,
      });
    }
    const prompt = structured
      ? structured.prepareInput(authoredPrompt)
      : authoredPrompt;

    let timedOut = false;

    // timeoutMs=0 means "no timeout" — skip the timer entirely
    const timeoutHandle =
      input.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            logger.warn("codex-task-runner.timeout", {
              workingDirectory: input.workingDirectory,
              timeoutMs: input.timeoutMs,
            });
            abortController.abort();
          }, input.timeoutMs)
        : null;

    // Fold an external cancellation signal into the same abort path so a
    // job-shaped caller can cancel a live run.
    // Inactivity watchdog: unlike the whole-run timeout above, this only
    // trips on dead air — every streamed thread event resets it.
    const stallTimeoutMs =
      input.stallTimeoutMs ?? CODEX_DEFAULT_STALL_TIMEOUT_MS;
    const stallWatchdog = createStallWatchdog({
      stallTimeoutMs,
      onStall: () => {
        logger.warn("codex-task-runner.stalled", {
          workingDirectory: input.workingDirectory,
          stallTimeoutMs,
        });
        abortController.abort();
      },
    });

    let threadId: string | null = null;
    let text: string | null = null;
    let structuredOutput: unknown;
    let usageResult: AgentTaskResult["usage"] = null;
    let transcript: AgentTranscriptEntry[] | undefined;
    let error: string | null = null;
    let processFailed = false;
    const wasResume = !isolatedOneShot && input.resumeRef?.backend === "codex";

    try {
      if (abortController.signal.aborted) {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      }

      const codex = this.deps.createCodex(codexOptions);

      let thread;
      if (!isolatedOneShot && input.resumeRef?.backend === "codex") {
        logger.info("codex-task-runner.resume", {
          threadId: input.resumeRef.ref,
        });
        thread = codex.resumeThread(input.resumeRef.ref, threadOptions);
      } else {
        thread = codex.startThread(threadOptions);
      }

      const turn = await runCodexTurn(thread, prompt, {
        ...(structured?.outputSchema
          ? { outputSchema: structured.outputSchema }
          : {}),
        signal: abortController.signal,
        onActivity: () => stallWatchdog.touch(),
      });

      // Read the thread id only after the turn: the SDK assigns a fresh
      // thread's id when the `thread.started` event arrives mid-run.
      threadId = thread.id;

      if (turn.items && turn.items.length > 0) {
        transcript = toRawTranscriptEntries("codex", turn.items);
      }

      if (turn.error) {
        error = turn.error;
        logger.warn("codex-task-runner.turn_failed", {
          workingDirectory: input.workingDirectory,
          error,
        });
      }

      if (turn.finalResponse) {
        text = turn.finalResponse;

        if (structured && !turn.error) {
          try {
            structuredOutput = structured.restore(
              JSON.parse(turn.finalResponse),
            );
          } catch {
            // finalResponse is not valid JSON despite outputSchema being set
          }
        }
      }

      if (turn.usage) {
        let pricingOverrides: CodexPricingTable | null = null;
        try {
          pricingOverrides = await this.deps.getCodexPricingOverrides();
        } catch (err) {
          logger.warn("codex-task-runner.pricing_overrides_unavailable", {
            workingDirectory: input.workingDirectory,
            error: getErrorMessage(err),
          });
        }
        usageResult = {
          inputTokens: turn.usage.input_tokens,
          cachedInputTokens: turn.usage.cached_input_tokens,
          outputTokens: turn.usage.output_tokens,
          costUsd: estimateCodexCostUsd(
            turn.usage,
            resolvedModelSelection.modelId,
            pricingOverrides,
          ),
        };
      }
    } catch (err) {
      if (!timedOut) {
        const name = err instanceof Error ? err.name : "";
        if (name === "AbortError" || name === "TimeoutError") {
          timedOut = true;
        } else {
          processFailed = true;
          error = getErrorMessage(err);
          logger.error("codex-task-runner.run_error", {
            workingDirectory: input.workingDirectory,
            error,
          });
        }
      }
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      stallWatchdog.cancel();
      externalSignal?.removeEventListener("abort", onExternalAbort);
    }

    const candidateBackendRef = isolatedOneShot
      ? null
      : threadId
        ? { backend: "codex" as const, ref: threadId }
        : wasResume
          ? input.resumeRef!
          : null;
    // A stall abort may surface as an AbortError throw or as a graceful
    // turn.failed reply to the interrupt; either way the stall is the cause.
    const stalled = stallWatchdog.fired();
    if (stalled) timedOut = true;
    const finalError = stalled
      ? `Task stalled: no backend activity for ${stallTimeoutMs}ms`
      : (error ?? (timedOut ? "Task timed out" : null));
    const failure =
      finalError === null ? null : codexFailureClassifier.classify(finalError);
    const continuationDisposition =
      failure?.kind === "stale_resume_ref" ||
      (failure !== null && processFailed && !wasResume)
        ? "clear"
        : "retain";
    const backendRef =
      continuationDisposition === "clear" ? null : candidateBackendRef;

    logger.info("codex-task-runner.complete", {
      workingDirectory: input.workingDirectory,
      threadId,
      timedOut,
      stalled,
      hasError: !!error,
      executionProfile: input.executionProfile ?? "standard",
    });

    return {
      backendRef,
      text,
      structuredOutput,
      usage: usageResult,
      ...(transcript ? { transcript } : {}),
      error: finalError,
      timedOut,
      failure,
      continuationDisposition,
    };
  }
}

async function listNativeMcpServers(
  cwd: string,
  env: Record<string, string>,
  deps: Pick<CodexTaskRunnerDeps, "listNativeCodexMcpServers">,
): Promise<NativeCodexMcpServer[]> {
  try {
    const servers = await deps.listNativeCodexMcpServers({ cwd, env });
    logger.info("codex-task-runner.mcp_native_servers_listed", {
      workingDirectory: cwd,
      nativeServerCount: servers.length,
    });
    return servers;
  } catch (err) {
    logger.warn("codex-task-runner.mcp_native_server_list_failed", {
      workingDirectory: cwd,
      error: getErrorMessage(err),
    });
    return [];
  }
}

export const codexTaskRunner = new CodexTaskRunner();
