/**
 * Prompt execution facade — delegates to the conversation XState machine.
 *
 * Keeps the same export signatures (`executePromptStream`, `createPromptExecutor`)
 * so callers (prompt-route-handlers.ts) don't need changes.
 * Internally replaces inline orchestration with the
 * conversation manager lifecycle.
 */

import type {
  SessionState,
  ImagePayload,
  ConversationToolingOverrides,
  AgentBackendId,
} from "@/types";
import type { ConversationActorRef } from "./workflows/conversation/machine";
import type { ConversationEvent } from "./workflows/conversation/types";
import { createLogger } from "./logging";
import {
  getConversation,
  createConversation,
  setConversationBackend,
} from "./conversations";
import { getProjectDisplayName } from "./project-resolver";
import { readConfig } from "./config";
import { getConversationBackendFactory } from "./agent-backends/registry";
import { randomUUID } from "node:crypto";

const logger = createLogger("prompt");

// ============================================================
// Constants (imported by actor-implementations.ts)
// ============================================================

/** Appended to the system prompt when session.tddEnabled is true. */
export const TDD_INSTRUCTIONS =
  "<methodology>Use red-green TDD. Write a failing test first, run it to confirm it fails, then write the minimum code to make it pass.</methodology>";

/** Appended to the system prompt when a conversation is in debug mode. Placeholders are replaced at runtime. */
export const DEBUG_MODE_INSTRUCTIONS = `<debug-mode>
You are in Debug Mode. Debug with runtime evidence, not static guesswork.

## Workflow
1. **Hypothesize + Instrument (same turn)**: Form 3-5 plausible root-cause hypotheses labeled H1, H2, etc., and immediately add the minimum instrumentation needed to test them in the same response. Explain what each hypothesis predicts and where you instrumented. Do not stop after listing hypotheses.
2. **Wait for Reproduction**: Provide clear numbered reproduction steps using a blockquote. The UI renders blockquotes as a styled card when in debug mode. Format exactly like this:

> **Reproduction Steps**
> 1. First step the user should take
> 2. Second step
> 3. What to observe

Do not continue until the user says reproduction is complete.
3. **Analyze Evidence**: Read \`{DEBUG_LOG_FILE_PATH}\` and determine which hypotheses are supported, refuted, or still inconclusive.
4. **Fix**: Make the smallest change justified by the evidence.
5. **Verify**: Ask the user to verify the fix.
6. **Clean Up**: After the user confirms the fix, remove all instrumentation you added.

## Debug Log API
POST logs to: {DEBUG_LOG_URL}

Each log entry must be a JSON object with:
- \`timestamp\`: ISO 8601 string
- \`hypothesisId\`: \`"H1"\`, \`"H2"\`, etc.
- \`location\`: \`"file/path.ts:lineNumber"\`
- \`message\`: human-readable description
- \`data\`: object with the runtime values needed to test the hypothesis

Keep logs narrowly targeted to decision points, inputs, outputs, state transitions, and invariants that distinguish between hypotheses. Instrumentation must be fire-and-forget and must never break the app.

## Instrumentation Markers

Every instrumentation block MUST be wrapped with structured comment markers so it can be reliably found and removed during cleanup.

**Multi-line blocks** — use START/END delimiters:
\`\`\`
// @debug-probe:{hypothesisId}:{slug} START
...instrumentation code...
// @debug-probe:{hypothesisId}:{slug} END
\`\`\`

**Single-line additions** (imports, variable declarations needed only for instrumentation):
\`\`\`
import { useRef } from "react"; // @debug-probe:{hypothesisId}:{slug}
\`\`\`

Format: \`@debug-probe:{hypothesisId}:{slug}\` where:
- \`{hypothesisId}\` is the hypothesis being tested (e.g., \`H1\`, \`H2\`)
- \`{slug}\` is a short kebab-case label (e.g., \`pre-dispatch\`, \`token-check\`)

Example instrumentation with markers:
\`\`\`typescript
// @debug-probe:H1:token-validation START
void fetch("{DEBUG_LOG_URL}", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    timestamp: new Date().toISOString(),
    hypothesisId: "H1",
    location: "src/lib/auth.ts:42",
    message: "Token validation result",
    data: { tokenPrefix: token?.slice(0, 8), isValid, userId }
  })
}).catch(() => {});
// @debug-probe:H1:token-validation END
\`\`\`

## Instrumentation Manifest

After adding instrumentation, write a manifest to \`.debug/instrumentation.json\` that tracks every probe. This manifest is the source of truth for cleanup.

\`\`\`json
{
  "conversationId": "the-conversation-id",
  "createdAt": "ISO 8601 timestamp",
  "probes": [
    {
      "id": "H1:token-validation",
      "file": "src/lib/auth.ts",
      "description": "Logs token validation result to test H1"
    },
    {
      "id": "H2:state-before-dispatch",
      "file": "src/app/api/route.ts",
      "description": "Captures actor state before event dispatch"
    }
  ]
}
\`\`\`

Each probe entry has:
- \`id\`: matches the \`{hypothesisId}:{slug}\` in the comment marker
- \`file\`: relative path to the instrumented file
- \`description\`: what this probe captures

Update the manifest whenever you add or remove probes during additional instrumentation passes.

## Cleanup Verification

During cleanup, after removing all instrumentation:
1. Read \`.debug/instrumentation.json\` to get the list of probed files
2. Remove all \`@debug-probe\` markers from those files
3. Run \`grep -r "@debug-probe" src/\` to verify zero results — if any remain, remove them
4. Delete \`.debug/instrumentation.json\`
5. Check each modified file for orphaned imports or variables that were only needed by removed probes

## Rules
- Never propose or implement a fix before reviewing runtime evidence from \`{DEBUG_LOG_FILE_PATH}\`.
- Prefer a few high-signal logs over broad tracing.
- If the evidence is incomplete, add another targeted instrumentation pass instead of guessing.
- NEVER remove instrumentation until the user clicks "Mark Fix". The user controls when cleanup happens, not you.
- ALL instrumentation MUST use \`@debug-probe\` comment markers and be tracked in \`.debug/instrumentation.json\`.
</debug-mode>`;

/**
 * Phase-specific context snippets prepended to every debug turn after the
 * initial instructions have been delivered. Keeps the agent focused on the
 * current phase without repeating the full workflow.
 */
export const DEBUG_PHASE_CONTEXT: Record<string, string> = {
  hypothesizing:
    "<debug-phase>Phase: HYPOTHESIZING. Form hypotheses, add instrumentation, and provide reproduction steps. Return structured JSON output.</debug-phase>",
  awaiting_reproduction:
    "<debug-phase>Phase: AWAITING REPRODUCTION. The user has not yet confirmed reproduction. Answer follow-up questions but do NOT analyze evidence or propose fixes yet.</debug-phase>",
  analyzing_evidence:
    "<debug-phase>Phase: ANALYZING EVIDENCE. Read the debug log file, classify hypotheses, and return structured JSON output. Do NOT implement fixes in this step.</debug-phase>",
  fixing:
    '<debug-phase>Phase: FIXING. Implement the minimal fix justified by the evidence. Return structured JSON with fixSummary and verificationSteps. Do NOT remove any instrumentation — cleanup only happens when the user clicks "Mark Fix".</debug-phase>',
  awaiting_verification:
    '<debug-phase>Phase: AWAITING VERIFICATION. The user is verifying the fix. Answer questions but do NOT remove instrumentation — cleanup only happens when the user clicks "Mark Fix".</debug-phase>',
  cleanup_instrumentation:
    '<debug-phase>Phase: CLEANUP. Remove ALL debug instrumentation you added (logging statements, fetch calls to the debug log API, etc.). Follow the cleanup procedure: read .debug/instrumentation.json for the probe manifest, remove all @debug-probe markers from listed files, run `grep -r "@debug-probe" src/` to verify none remain, delete .debug/instrumentation.json, and check for orphaned imports. Return structured JSON confirming removal.</debug-phase>',
};

/** Appended to every system prompt to orient the agent about its CC environment. */
export const CC_CONTEXT =
  "<command-center>You are running inside Command Center (CC), a web-based control plane for managing remote Claude Code sessions. Your session runs in an isolated git worktree with its own branch. CC provides custom MCP tools: roadmap tools for tracking bugs/features/ideas, and a notification tool to send push notifications to the user's phone when warranted (e.g., long tasks complete, user asked to be notified). Stay within your worktree — CC manages merging, dev servers, and session lifecycle.</command-center>";

// ============================================================
// Dependency Injection (simplified — facade only needs conversation CRUD)
// ============================================================

export interface PromptDeps {
  getConversation: typeof getConversation;
  createConversation: typeof createConversation;
  setConversationBackend: typeof setConversationBackend;
  getProjectDisplayName: typeof getProjectDisplayName;
  readConfig: typeof readConfig;
  getConversationBackendFactory: typeof getConversationBackendFactory;

  // Manager operations — injected to avoid vi.mock() on the manager module
  ensureConversationActor(
    projectPath: string,
    sessionName: string,
    conversationId: string,
  ): Promise<ConversationActorRef>;
  attachPromptStream(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    streamId: string,
    emit: (event: string, data: unknown) => void,
  ): void;
  detachPromptStream(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    streamId: string,
  ): void;
  sendConversationEvent(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    event: ConversationEvent,
  ): boolean;

  setTooling?(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    tooling: ConversationToolingOverrides,
  ): void;

  setSkipSessionLock?(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    skip: boolean,
  ): void;
}

let _defaultPromptDeps: PromptDeps | null = null;

async function getDefaultPromptDeps(): Promise<PromptDeps> {
  if (_defaultPromptDeps) return _defaultPromptDeps;
  const manager = await import("./workflows/conversation/manager");
  const runtimeState = await import("./workflows/conversation/runtime-state");
  _defaultPromptDeps = {
    getConversation,
    createConversation,
    setConversationBackend,
    getProjectDisplayName,
    readConfig,
    getConversationBackendFactory,
    ensureConversationActor: manager.ensureConversationActor,
    attachPromptStream: manager.attachPromptStream,
    detachPromptStream: manager.detachPromptStream,
    sendConversationEvent: manager.sendConversationEvent,
    setTooling: (projectPath, sessionName, conversationId, tooling) => {
      const key = runtimeState.conversationRuntimeKey(
        projectPath,
        sessionName,
        conversationId,
      );
      const runtime = runtimeState.getConversationRuntime(key);
      if (runtime) {
        runtime.tooling = tooling;
      }
    },
    setSkipSessionLock: (projectPath, sessionName, conversationId, skip) => {
      const key = runtimeState.conversationRuntimeKey(
        projectPath,
        sessionName,
        conversationId,
      );
      const runtime = runtimeState.getConversationRuntime(key);
      if (runtime) {
        runtime.skipSessionLock = skip;
      }
    },
  };
  return _defaultPromptDeps;
}

/**
 * Create a prompt executor with injected dependencies.
 * Tests use this to inject mocks; production uses the default singleton export.
 */
export function createPromptExecutor(deps: PromptDeps) {
  return {
    executePromptStream: (
      projectPath: string,
      session: SessionState,
      promptText: string,
      emit: (event: string, data: unknown) => void,
      conversationId?: string,
      modelId?: string,
      images?: ImagePayload[],
      options?: PromptStreamOptions,
    ) =>
      executePromptStream(
        projectPath,
        session,
        promptText,
        emit,
        conversationId,
        modelId,
        images,
        options,
        deps,
      ),
  };
}

export interface PromptStreamOptions {
  autonomous?: boolean;
  effort?: string;
  backend?: AgentBackendId;
  tooling?: ConversationToolingOverrides;
  skipSessionLock?: boolean;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
}

export interface PromptStreamResult {
  conversationId: string;
  contextTokens: number | null;
  contextWindowMax: number | null;
  structuredOutput?: unknown;
}

/**
 * Execute a prompt by delegating to the conversation XState machine.
 *
 * 1. Get-or-create conversation
 * 2. Ensure a conversation actor is running
 * 3. Attach the SSE emit callback
 * 4. Send SUBMIT_PROMPT event
 * 5. Wait for the actor to complete the turn (returns to idle/debug/done)
 * 6. Detach stream
 */
export async function executePromptStream(
  projectPath: string,
  session: SessionState,
  promptText: string,
  emit: (event: string, data: unknown) => void,
  conversationId?: string,
  modelId?: string,
  images?: ImagePayload[],
  options?: PromptStreamOptions,
  deps?: PromptDeps,
): Promise<PromptStreamResult> {
  const resolvedDeps = deps ?? (await getDefaultPromptDeps());

  // Get or create conversation, resolving backend along the way
  let resolvedBackend: AgentBackendId;
  if (conversationId) {
    const existing = await resolvedDeps.getConversation(
      projectPath,
      session.sessionName,
      conversationId,
    );
    if (!existing) {
      throw new Error(`Conversation not found: ${conversationId}`);
    }
    // Backend is locked after the first prompt has been sent
    if (options?.backend && options.backend !== existing.agentBackend) {
      if (existing.promptCount > 0) {
        const err = new BackendMismatchError(
          existing.agentBackend,
          options.backend,
        );
        logger.warn("prompt.backend_mismatch", {
          conversationId,
          existingBackend: existing.agentBackend,
          requestedBackend: options.backend,
        });
        throw err;
      }
      // No prompts yet — adopt the requested backend
      await resolvedDeps.setConversationBackend(
        projectPath,
        session.sessionName,
        conversationId,
        options.backend,
      );
      logger.info("prompt.backend_adopted", {
        conversationId,
        from: existing.agentBackend,
        to: options.backend,
      });
    }
    resolvedBackend = options?.backend ?? existing.agentBackend;
  } else {
    // New conversation: use explicit backend or config default
    if (options?.backend) {
      resolvedBackend = options.backend;
    } else {
      const config = await resolvedDeps.readConfig();
      resolvedBackend = config.defaultAgentBackend ?? "claude";
    }
    const conversation = await resolvedDeps.createConversation(
      projectPath,
      session.sessionName,
      { agentBackend: resolvedBackend },
    );
    conversationId = conversation.id;
  }

  // Validate model/effort via the backend factory before execution
  const factory = resolvedDeps.getConversationBackendFactory(resolvedBackend);
  if (factory.validateModelAndEffort) {
    try {
      factory.validateModelAndEffort({
        modelId: modelId ?? undefined,
        reasoningEffort: options?.effort,
      });
    } catch (err) {
      logger.warn("prompt.model_effort_validation_failed", {
        backend: resolvedBackend,
        modelId,
        effort: options?.effort,
        error: err instanceof Error ? err.message : String(err),
      });
      throw new ModelEffortValidationError(
        err instanceof Error
          ? err.message
          : "Invalid model or effort for backend",
      );
    }
  }

  const streamId = randomUUID();

  logger.info("prompt.submit", {
    sessionName: session.sessionName,
    promptLength: promptText.length,
    model: modelId ?? "default",
    backend: resolvedBackend,
    conversationId,
  });

  // Ensure actor exists (creates if needed, loading from state)
  const actor = await resolvedDeps.ensureConversationActor(
    projectPath,
    session.sessionName,
    conversationId,
  );

  // Register per-invocation tooling overrides on the conversation runtime state
  if (options?.tooling) {
    resolvedDeps.setTooling?.(
      projectPath,
      session.sessionName,
      conversationId,
      options.tooling,
    );
  }

  // Allow validator conversations to bypass the session lock
  if (options?.skipSessionLock) {
    resolvedDeps.setSkipSessionLock?.(
      projectPath,
      session.sessionName,
      conversationId,
      true,
    );
  }

  // Attach SSE stream
  resolvedDeps.attachPromptStream(
    projectPath,
    session.sessionName,
    conversationId,
    streamId,
    emit,
  );

  try {
    // Send the prompt event to the machine
    resolvedDeps.sendConversationEvent(
      projectPath,
      session.sessionName,
      conversationId,
      {
        type: "SUBMIT_PROMPT",
        promptText,
        images,
        backend: resolvedBackend,
        modelId,
        effort: options?.effort,
        autonomous: options?.autonomous,
        streamId,
        outputFormat: options?.outputFormat,
      },
    );

    // Wait for the turn to complete: actor reaches idle, debug.*, or done
    await waitForTurnCompletion(actor);

    logger.info("prompt.complete", {
      sessionName: session.sessionName,
      conversationId,
    });

    emit("done", {});
    return readContextFromActor(actor, conversationId);
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : "Prompt failed";
    logger.error("prompt.facade_error", {
      sessionName: session.sessionName,
      conversationId,
      error: errorMsg,
    });
    emit("error", { message: errorMsg });
    emit("done", {});
    return readContextFromActor(actor, conversationId);
  } finally {
    resolvedDeps.detachPromptStream(
      projectPath,
      session.sessionName,
      conversationId,
      streamId,
    );
  }
}

// ============================================================
// Error types for backend validation
// ============================================================

export class BackendMismatchError extends Error {
  readonly statusCode = 409;
  constructor(
    public readonly existingBackend: AgentBackendId,
    public readonly requestedBackend: AgentBackendId,
  ) {
    super(
      `Backend mismatch: conversation uses "${existingBackend}" but request specified "${requestedBackend}"`,
    );
    this.name = "BackendMismatchError";
  }
}

export class ModelEffortValidationError extends Error {
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "ModelEffortValidationError";
  }
}

/**
 * Read context token usage from the actor snapshot after a turn completes.
 */
function readContextFromActor(
  actor: ConversationActorRef,
  conversationId: string,
): PromptStreamResult {
  const snap = actor.getSnapshot();
  const ctx = snap.context as unknown as Record<string, unknown>;
  const totals = ctx?.totals as
    | { contextTokens?: number | null; contextWindowMax?: number | null }
    | undefined;
  const lastResult = ctx?.lastResult as
    | { structuredOutput?: unknown }
    | undefined;
  return {
    conversationId,
    contextTokens: totals?.contextTokens ?? null,
    contextWindowMax: totals?.contextWindowMax ?? null,
    structuredOutput: lastResult?.structuredOutput,
  };
}

/**
 * Wait for the conversation actor to finish the current turn.
 * Resolves when the actor returns to idle/debug/done state.
 * Rejects if the actor errors.
 */
function waitForTurnCompletion(actor: ConversationActorRef): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // Check if already idle (no active turn)
    const snap = actor.getSnapshot();
    if (snap.status === "done") {
      resolve();
      return;
    }

    const isSettled = (stateValue: unknown): boolean => {
      if (stateValue === "idle") return true;
      if (
        typeof stateValue === "object" &&
        stateValue !== null &&
        "debug" in stateValue
      )
        return true;
      return false;
    };

    // If the machine hasn't started acquiring resources yet, we need to wait
    // for the SUBMIT_PROMPT to take effect first
    const initialValue = snap.value;
    let sawTransition = false;

    const sub = actor.subscribe((snapshot) => {
      // Track that a state transition occurred (machine left idle/debug)
      if (!sawTransition && !isSettled(snapshot.value)) {
        sawTransition = true;
      }

      if (snapshot.status === "done") {
        sub.unsubscribe();
        resolve();
        return;
      }

      if (snapshot.status === "error") {
        sub.unsubscribe();
        reject(new Error("Conversation actor errored"));
        return;
      }

      // Only resolve when we've seen a transition AND come back to settled
      if (sawTransition && isSettled(snapshot.value)) {
        sub.unsubscribe();
        resolve();
      }
    });

    // If the actor is already settled and hasn't transitioned,
    // check after a microtask to allow the SUBMIT_PROMPT event to be processed
    if (isSettled(initialValue)) {
      queueMicrotask(() => {
        const current = actor.getSnapshot();
        if (current.status === "done") {
          sub.unsubscribe();
          resolve();
        }
      });
    }
  });
}
