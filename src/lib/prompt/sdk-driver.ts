/**
 * Prompt execution facade — delegates to the conversation lifecycle module.
 *
 * Keeps the same export signatures (`executePromptStream`, `createPromptExecutor`)
 * so callers (prompt-route-handlers.ts) don't need changes.
 * The lifecycle module hides its state-machine implementation and returns a
 * stable turn projection.
 */

import type { ConversationToolingOverrides } from "@/lib/agent-backends/types";
import type { BackgroundWaitSummary } from "@/lib/agent-backends/conversation";
import type { DocumentFeedbackPayload } from "@/lib/conversations/message-content-schemas";
import type { ImagePayload } from "@/lib/images/schemas";
import type { SessionState } from "@/lib/sessions/schemas";
import { getErrorMessage } from "@/lib/shared/errors";
import {
  DEFAULT_AGENT_BACKEND_ID,
  type AgentBackendId,
} from "@/lib/shared/schemas";
import type { CollaborationAutonomousResolutionThreshold } from "@/lib/workflow-graph/collaboration-schemas";
import type {
  EnsureActorInputData,
  ExecuteConversationTurnInput,
  ConversationTurnExecution,
} from "@/lib/workflows/conversation/manager";
import type { ExecutionTarget } from "@/lib/workflow-graph/execution-target-resolver";
import type { RunCommandOutcome } from "@/lib/conversation-commands/service";
import type { ConversationCommandDispatchInput } from "@/lib/conversation-commands/dispatch";
import { ticketCommandFallbackMessage } from "@/lib/conversation-commands/ticket-confirmation";
import { dispatchConversationCommand as defaultDispatchConversationCommand } from "@/lib/conversation-commands/dispatch";
import { createLogger } from "@/lib/logging";
import { parseConversationCommand } from "@/lib/conversation-commands/parse";
import { isProjectSentinel } from "@/lib/conversations/project-conversation-scope";
import {
  getConversation,
  createConversation,
  setConversationBackend,
} from "@/lib/conversations/service";
import { getProjectDisplayName } from "@/lib/projects/resolver";
import { readConfig } from "@/lib/config/loader";
import { getConversationBackendFactory } from "@/lib/agent-backends/registry";
import { randomUUID } from "node:crypto";

const logger = createLogger("prompt");

// ============================================================
// Constants (imported by actor-implementations.ts)
// ============================================================

/** Appended to the system prompt when session.tddEnabled is true. */
export const TDD_INSTRUCTIONS =
  "<methodology>Use red-green TDD. Write a failing test first, run it to confirm it fails, then write the minimum code to make it pass.</methodology>";

/**
 * Appended to the system prompt when a conversation is in debug mode.
 * Placeholders are replaced at runtime.
 *
 * NOTE: This prompt instructs the agent to produce two machine-readable
 * artifacts as side effects rather than as the agent's text response:
 *   1. `.debug/instrumentation.json` — written via the filesystem `Write`
 *      tool. Validated post-write by `debugInstrumentationManifestSchema`
 *      (from `@/lib/debug-log/schemas`) in `src/lib/debug-log.ts:readManifest`.
 *   2. Per-probe JSON entries POSTed to `{DEBUG_LOG_URL}` from the
 *      instrumented app at runtime. Validated per-request by
 *      `debugLogEntrySchema.safeParse` in `src/app/api/debug-logs/route.ts`.
 *
 * Neither contract uses the turn's `outputFormat` because neither artifact
 * travels through the agent's text response — the manifest is a file the agent
 * writes during the same turn, and the log entries are HTTP requests the
 * instrumented code makes at user-reproduction time. Structured-output
 * transport cannot constrain side effects of tool calls; instead, both
 * contracts are enforced at consumption via Zod schemas in
 * `@/lib/debug-log/schemas`.
 *
 * The agent's actual *text* response carries the per-phase `outputFormat`
 * derived from `debug-schemas.ts` through the shared backend pipeline (see the
 * conversation lifecycle module).
 */
export const DEBUG_MODE_INSTRUCTIONS = `<debug-mode>
You are in Debug Mode. Debug with runtime evidence, not static guesswork.

## Workflow
1. **Hypothesize + Instrument (same turn)**: Form 3-5 plausible root-cause hypotheses labeled H1, H2, etc., and immediately add the minimum instrumentation needed to test them in the same response. Explain what each hypothesis predicts and where you instrumented. Do not stop after listing hypotheses.
2. **Wait for Reproduction**: Return clear ordered reproduction steps as the \`reproductionSteps\` array in your structured JSON output. The UI renders the steps deterministically from that field. Do not continue until the user says reproduction is complete.
3. **Analyze Evidence (same turn fix or re-instrument)**: Read \`{DEBUG_LOG_FILE_PATH}\` and classify each hypothesis as supported, refuted, or inconclusive. Then choose ONE outcome based on whether the evidence is sufficient to justify a fix:
   - **\`fix_applied\`**: when at least one hypothesis is well-supported and the rest are refuted or inconclusive, implement the minimal fix in this same turn and return verification steps.
   - **\`more_instrumentation\`**: when evidence is inconclusive or insufficient, extend the hypothesis set, add fresh targeted instrumentation in the same turn, and return reproduction steps the user should re-execute.
4. **Verify**: Ask the user to verify the applied fix.
5. **Clean Up**: After the user clicks "Mark Fixed", remove all instrumentation you added.

## Debug Log API
POST logs to: {DEBUG_LOG_URL}

Each log entry must be a JSON object with:
- \`timestamp\`: ISO 8601 string
- \`hypothesisId\`: \`"H1"\`, \`"H2"\`, etc.
- \`location\`: \`"file/path.ts:lineNumber"\`
- \`message\`: human-readable description
- \`data\`: object with the runtime values needed to test the hypothesis

Probes must NOT set the \`X-CC-Debug-Log: 1\` header. The receiver drops every request carrying that header as a self-instrumentation signal, so adding it from a normal probe silently discards every entry. The header is reserved for one narrow case: when the project being debugged is Command Center itself and your probe sits inside CC's own debug-log code path. In that scenario only, set the header (and have any \`fetch\` wrapper skip requests carrying it) so the receiver short-circuits the recursive POST. If you are not debugging CC, omit the header entirely.

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

After adding instrumentation, write a manifest to \`{DEBUG_MANIFEST_PATH}\` that tracks every probe. This manifest is the source of truth for cleanup.

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
1. Read \`{DEBUG_MANIFEST_PATH}\` to get the list of probed files
2. Remove all \`@debug-probe\` markers from those files
3. Run \`grep -r "@debug-probe" src/\` to verify zero results — if any remain, remove them
4. Do NOT delete \`{DEBUG_MANIFEST_PATH}\` yourself; Command Center cross-checks your structured report against the manifest and removes the file only after the verification passes. Set \`acknowledgesManifestDeletionContract: true\` in your structured response to confirm you understand CC owns the deletion.
5. Check each modified file for orphaned imports or variables that were only needed by removed probes

## Rules
- Never propose or implement a fix before reviewing runtime evidence from \`{DEBUG_LOG_FILE_PATH}\`.
- Prefer a few high-signal logs over broad tracing.
- If the evidence is incomplete, add another targeted instrumentation pass instead of guessing.
- During the analyze-evidence phase you ARE permitted (and expected, when the runtime evidence is sufficient) to implement the minimal fix in the same turn. Cleanup of debug instrumentation is still deferred until the user clicks "Mark Fixed".
- NEVER remove instrumentation until the user clicks "Mark Fixed". The user controls when cleanup happens, not you.
- ALL instrumentation MUST use \`@debug-probe\` comment markers and be tracked in \`{DEBUG_MANIFEST_PATH}\`.
</debug-mode>`;

/**
 * Phase-specific context snippets prepended to every debug turn after the
 * initial instructions have been delivered. Keeps the agent focused on the
 * current phase without repeating the full workflow.
 */
export const DEBUG_PHASE_CONTEXT: Record<string, string> = {
  hypothesizing:
    '<debug-phase>Phase: HYPOTHESIZING. Form hypotheses, add instrumentation, and provide reproduction steps. Return structured JSON with EVERY one of these fields:\n- `hypotheses` (array, 3\u20135 items): each item has `id` (sequential labels "H1", "H2", \u2026 \u2014 use higher numbers when extending an earlier set), `description` (one sentence), and `instrumentationPlan` (concrete probes you will add).\n- `reproductionSteps` (string[], at least 2): only the user-facing actions to reproduce the bug, written as imperatives ("Click X", "Send a request to Y"). Do NOT include closing remarks directed at yourself or the user (e.g. "tell me when done") \u2014 those belong in the conversational text outside the structured output.</debug-phase>',
  awaiting_reproduction:
    "<debug-phase>Phase: AWAITING REPRODUCTION. The user has not yet confirmed reproduction. Answer follow-up questions but do NOT analyze evidence or propose fixes yet.</debug-phase>",
  analyzing_evidence:
    '<debug-phase>Phase: ANALYZING EVIDENCE. Read the debug log file at {DEBUG_LOG_FILE_PATH} and classify each hypothesis as supported, refuted, or inconclusive based strictly on what the logs show. Then choose ONE of two outcomes based on whether the evidence is sufficient to justify a fix:\n\n(a) FIX_APPLIED \u2014 If at least one hypothesis is well-supported and the rest are refuted or inconclusive AND the evidence is sufficient to commit to a minimal fix, IMPLEMENT THE FIX IN THIS SAME TURN. Return structured JSON with EVERY one of these fields:\n- `outcome`: "fix_applied"\n- `supportedHypotheses` (string[]): hypothesis ids ("H1", "H2", \u2026) the evidence supports.\n- `refutedHypotheses` (string[]): ids the evidence refutes.\n- `inconclusiveHypotheses` (string[]): ids that need more evidence.\n- `evidenceSummary` (string): short prose summary tying log lines to hypotheses.\n- `fixSummary` (string): one or two sentences naming what changed and why.\n- `verificationSteps` (string[], at least 1): the concrete steps the user runs to verify the fix.\nDo NOT remove any instrumentation in this turn \u2014 cleanup only happens when the user clicks "Mark Fixed".\n\n(b) MORE_INSTRUMENTATION \u2014 If the existing evidence is inconclusive or insufficient, EXTEND THE HYPOTHESIS SET and add fresh debug instrumentation in this same turn (using @debug-probe markers and updating {DEBUG_MANIFEST_PATH}). Return structured JSON with EVERY one of these fields:\n- `outcome`: "more_instrumentation"\n- `supportedHypotheses`, `refutedHypotheses`, `inconclusiveHypotheses` (string[]): classification of the existing hypotheses.\n- `evidenceSummary` (string): short prose summary tying log lines to hypotheses.\n- `hypotheses` (array, 1\u20135 items): the extended hypothesis set, each with `id` (sequential labels "H1", "H2", \u2026 \u2014 continue numbering past the prior round; do NOT reuse earlier ids), `description`, and `instrumentationPlan`.\n- `reproductionSteps` (string[], at least 1): imperative steps the user should re-execute so the new probes capture evidence.\n\nThe choice between (a) and (b) depends on whether the existing evidence is sufficient to justify a fix.</debug-phase>',
  awaiting_verification:
    '<debug-phase>Phase: AWAITING VERIFICATION. The user is verifying the fix. Answer questions but do NOT remove instrumentation — cleanup only happens when the user clicks "Mark Fixed".</debug-phase>',
  cleanup_instrumentation:
    '<debug-phase>Phase: CLEANUP. Remove ALL debug instrumentation you added (logging statements, fetch calls to the debug log API, etc.). Follow the cleanup procedure: read {DEBUG_MANIFEST_PATH} for the probe manifest, remove all @debug-probe markers from every file listed there, run `grep -r "@debug-probe" src/` to verify none remain, and check for orphaned imports. Do NOT delete {DEBUG_MANIFEST_PATH} yourself — Command Center cross-checks your structured report against the manifest and removes the manifest after a passing verification.\n\nReturn structured JSON with EVERY one of these fields:\n- `removedInstrumentation` (boolean): true once every @debug-probe marker has been removed.\n- `filesModified` (string[]): every file path listed in the manifest must appear here. Use repository-relative paths.\n- `grepVerificationPassed` (boolean): true when `grep -r "@debug-probe" src/` returned zero results.\n- `acknowledgesManifestDeletionContract` (boolean): set to true to confirm you understand CC (not the agent) deletes the manifest.\n- `notes` (string): brief summary of the cleanup; "" if nothing notable.</debug-phase>',
};

/** Appended to every system prompt to orient the agent about its CC environment. */
export const CC_CONTEXT =
  "<command-center>You are running inside Command Center (CC), a web-based control plane for managing remote Claude Code sessions. Your session runs in an isolated git worktree with its own branch. CC provides the `cctl` CLI (on your PATH) for session actions — e.g. `cctl notify` to send push notifications to the user's phone when warranted (long tasks complete, user asked to be notified); see the `cc-cli` skill for the full command reference. Stay within your worktree — CC manages merging, dev servers, and session lifecycle.\n\nDev servers: before driving Playwright, browser, visual, or Next.js MCP tools, run `cctl dev ensure` to obtain the correct localUrl/remoteUrl for THIS session's worktree. Never assume ports like 3000 or 6006 belong to you — parallel sessions live on different ports. Use `cctl dev list` to inspect current status. Only ask the user to start a server from the UI if `cctl dev ensure` reports NO_DEV_SERVERS_CONFIGURED or an unrecoverable start failure.\n\nBackground tasks: to let a long-running command (test suite, build, watcher) outlive your turn, use the Bash tool's run_in_background option — never detach with nohup/&/disown. Tracked background tasks keep your agent session alive until they settle and re-invoke you on completion; a detached process is invisible to that machinery, so nothing holds the session open for it, nothing wakes you when it finishes, and it dies silently with the session.</command-center>";

/**
 * Appended to every CC agent's system prompt (session and project
 * conversations alike) to encourage asking the user at real forks — via
 * `cctl ask` — instead of guessing on consequential choices, and to pin the
 * async protocol's end-turn discipline (docs/design/cc-cli/03 §7). Flag
 * details and examples live in the cc-cli skill, loaded on demand.
 */
export const ASK_QUESTION_INSTRUCTIONS =
  "<asking-questions>To ask the user a question, run `cctl ask` (see the cc-cli skill) — it renders your questions as a rich multiple-choice panel the user answers in a couple of clicks, so asking is far cheaper than guessing wrong on a consequential, hard-to-reverse, or genuinely ambiguous decision; default to asking at real forks instead of silently deciding for the user. Batch related questions into one call (a single batch pends at a time), and give options substance: each option can carry a description, a recommended flag (rendered as a Suggested badge), and a tradeoff with pro/con — author the batch as JSON and pass it with --file to use them (shape in the skill). Asking is ASYNC: after `cctl ask` succeeds, write a brief handoff note (what you asked, what you'll do with each possible answer) and END YOUR TURN — do not start new work. The answers arrive as a <cc-question-answers> block in your next user message; an answer with `skipped: true` means the user declined that question — proceed with best judgment. Skip asking for trivial, reversible, or easily-inferred choices — make a sensible call and keep moving. (Asking is denied for autonomous turns; use your best judgment there.)</asking-questions>";

/**
 * The workflow-lane variant of {@link ASK_QUESTION_INSTRUCTIONS}, selected when
 * a graph-workflow context resolves its ask-user-questions toggle on AND the
 * lane holds a real CC conversation (see `selectAskQuestionInstructions`). It
 * tells the lane agent the tool IS available and states the full protocol,
 * including that the workflow PAUSES this context until the user answers — so
 * asking is a real, non-free action, not a throwaway. Unlike the default
 * variant it omits the autonomous-denied disclaimer.
 */
export const ASK_QUESTION_INSTRUCTIONS_ENABLED =
  "<asking-questions>The `cctl ask` tool IS available on this turn to ask the user a question (see the cc-cli skill) — it renders your questions as a rich multiple-choice panel the user answers in a couple of clicks. Ask ONLY at a consequential, hard-to-reverse, or genuinely ambiguous decision point where a wrong guess would send this context and its downstream dependents down the wrong path; do not ask about trivial, reversible, or easily-inferred choices — make a sensible call and keep moving. Batch related questions into ONE `cctl ask` invocation (a single batch pends at a time), and give options substance: each option can carry a description, a recommended flag (rendered as a Suggested badge), and a tradeoff with pro/con — author the batch as JSON and pass it with --file to use them (shape in the skill). After `cctl ask` succeeds, write a brief handoff note (what you asked, what you'll do with each possible answer) and END YOUR TURN — do not start new work. The workflow PAUSES this context until the user answers, so asking is not a lightweight or free action — the whole context waits. The answers arrive as a <cc-question-answers> block when this context RESUMES; an answer with `skipped: true` means the user declined that question — proceed with your best judgment.</asking-questions>";

/**
 * Chooses the asking-questions session-instruction block for a turn. Workflow
 * lanes whose effective toggle is on (resolved toggle AND lane-can-ask) get the
 * enabled variant; every other turn (non-workflow conversations, disabled
 * lanes, Codex validator lanes) keeps the default autonomous-denied guidance.
 */
export function selectAskQuestionInstructions(
  askUserQuestionsEnabled: boolean | undefined,
): string {
  return askUserQuestionsEnabled === true
    ? ASK_QUESTION_INSTRUCTIONS_ENABLED
    : ASK_QUESTION_INSTRUCTIONS;
}

/**
 * One-line nudge (docs/design/cc-cli/01 §7) pointing every CC agent at the
 * cctl CLI; detail lives in the command-center:cc-cli skill, loaded on demand.
 */
export const CC_CLI_INSTRUCTIONS =
  "Command Center actions (notifications, questions, documents, dev servers, workflows) go through the `cctl` CLI — see the cc-cli skill.";

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

  // Lifecycle operations — injected to avoid vi.mock() on the manager module
  ensureConversationLifecycle(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    options?: {
      executionTarget?: ExecutionTarget;
      actorInput?: EnsureActorInputData;
    },
  ): Promise<void>;
  executeConversationTurn(
    input: ExecuteConversationTurnInput,
  ): Promise<ConversationTurnExecution>;

  setTooling?(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    tooling: ConversationToolingOverrides,
  ): void;

  setWorkflowContext?(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    workflowContext: { executionId: string; contextId: string },
  ): void;

  setSkipConversationLock?(
    projectPath: string,
    sessionName: string,
    conversationId: string,
    skip: boolean,
  ): void;

  /**
   * Dispatches a `/collab` prompt to the collaboration manager.
   *
   * `executePromptStream` calls this when it detects a /collab prefix instead
   * of running the normal conversation-turn flow. The dispatcher is responsible
   * for persisting the user's prompt to the conversation transcript and
   * starting the collaboration workflow. Returns the workflowId so the caller
   * can emit a `collab-started` SSE event.
   */
  dispatchCollabStart?(input: {
    projectPath: string;
    sessionName: string;
    conversationId: string;
    brief: string;
    negotiationRounds?: number;
    autonomousResolutionThreshold?: CollaborationAutonomousResolutionThreshold;
    modelId?: string;
    effort?: string;
    images?: ImagePayload[];
  }): Promise<{ workflowId: string }>;

  /**
   * Dispatches a `/commit` or `/merge` conversation command to the command
   * service. `executePromptStream` calls this when `parseConversationCommand`
   * matches, instead of running the normal conversation-turn flow. The dispatcher
   * is responsible for persisting the user's command message (`rawText`) to
   * the conversation transcript and running the command service to completion
   * — the route awaits the returned promise.
   */
  dispatchConversationCommand?(
    input: ConversationCommandDispatchInput,
  ): Promise<RunCommandOutcome>;
}

let _defaultPromptDeps: PromptDeps | null = null;

const DEFAULT_NEGOTIATION_ROUNDS = 3;
const DEFAULT_AUTONOMOUS_RESOLUTION_THRESHOLD: CollaborationAutonomousResolutionThreshold =
  "major";

async function getDefaultPromptDeps(): Promise<PromptDeps> {
  if (_defaultPromptDeps) return _defaultPromptDeps;
  const manager = await import("@/lib/workflows/conversation/manager");
  const runtimeState =
    await import("@/lib/workflows/conversation/runtime-state");
  const collabModule = await import("@/lib/workflows/collaboration/manager");
  _defaultPromptDeps = {
    getConversation,
    createConversation,
    setConversationBackend,
    getProjectDisplayName,
    readConfig,
    getConversationBackendFactory,
    ensureConversationLifecycle: manager.ensureConversationLifecycle,
    executeConversationTurn: manager.executeConversationTurn,
    async dispatchCollabStart(input) {
      const collabManager = collabModule.getDefaultCollaborationManager();
      const startInput: Parameters<typeof collabManager.start>[0] = {
        projectPath: input.projectPath,
        sessionName: input.sessionName,
        conversationId: input.conversationId,
        brief: input.brief,
        negotiationRounds:
          input.negotiationRounds ?? DEFAULT_NEGOTIATION_ROUNDS,
        autonomousResolutionThreshold:
          input.autonomousResolutionThreshold ??
          DEFAULT_AUTONOMOUS_RESOLUTION_THRESHOLD,
        ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
        ...(input.images?.length ? { images: input.images } : {}),
      };
      const result = await collabManager.start(startInput);
      return { workflowId: result.workflowId };
    },
    dispatchConversationCommand: defaultDispatchConversationCommand,
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
    setWorkflowContext: (
      projectPath,
      sessionName,
      conversationId,
      workflowContext,
    ) => {
      const key = runtimeState.conversationRuntimeKey(
        projectPath,
        sessionName,
        conversationId,
      );
      const runtime = runtimeState.getConversationRuntime(key);
      if (runtime) {
        runtime.workflowContext = workflowContext;
      }
    },
    setSkipConversationLock: (
      projectPath,
      sessionName,
      conversationId,
      skip,
    ) => {
      const key = runtimeState.conversationRuntimeKey(
        projectPath,
        sessionName,
        conversationId,
      );
      const runtime = runtimeState.getConversationRuntime(key);
      if (runtime) {
        runtime.skipConversationLock = skip;
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
  /**
   * Called once the prompt, command, or collaboration request has been
   * accepted by its execution owner. Failures are logged without changing the
   * accepted execution's outcome.
   */
  onAccepted?: () => void | Promise<void>;
  tooling?: ConversationToolingOverrides;
  /**
   * Graph-workflow lane identity. Set only by the implementer runner; threaded
   * onto the conversation runtime state and into the session env so `cctl
   * workflow …` resolves its execution/context from env. Every other caller
   * leaves it unset, so non-lane sessions carry neither var.
   */
  workflowContext?: { executionId: string; contextId: string };
  skipConversationLock?: boolean;
  // `outputFormat` is intentionally opt-in. Regular user-facing chat is
  // free-form markdown by design — requiring a JSON schema would prevent the
  // streaming chat response the UI renders. Workflow callers (debug mode,
  // validator, collaboration round responses) opt into the backend-neutral
  // structured-output pipeline; everyone else gets unconstrained text.
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  collab?: CollabPromptConfig;
  /**
   * When supplied, the conversation actor input uses this resolved target's
   * worktreePath instead of `session.worktreePath`. Solo-eligible graph
   * workflow contexts leave this undefined so behavior matches the
   * pre-parallelization session-worktree flow.
   */
  executionTarget?: ExecutionTarget;
  /**
   * Explicit lifecycle input that bypasses the manager's session-based loader.
   * The session-less project-conversation
   * entry supplies this (built from the project record + repo-root worktree)
   * because the conversation has no host session to load from.
   */
  actorInput?: EnsureActorInputData;
  /**
   * Opt-in: hold the turn open after the agent yields until its in-flight
   * waitable background tasks settle (or the wait times out). Set only by the
   * graph-workflow implementer runner; every other caller (interactive chat,
   * planner/validator/collab turns) leaves it unset so behavior is unchanged.
   */
  waitForBackgroundTasks?: boolean;
  /**
   * Structured document-review feedback to record on the user turn. When set,
   * the turn's transcript carries a `document_feedback` block and the
   * agent-facing prompt text is derived from it when `promptText` is empty.
   * Unset for every non-feedback send.
   */
  documentFeedback?: DocumentFeedbackPayload;
  /**
   * Effective ask-user-questions availability for this turn: the resolved
   * per-context toggle AND the lane holding a real conversation. Set only by
   * the graph-workflow runners; when true the session instructions select the
   * enabled asking-questions variant. Every other caller leaves it unset, so
   * non-workflow conversations keep the default autonomous-denied guidance.
   */
  askUserQuestionsEnabled?: boolean;
}

export interface PromptStreamResult {
  conversationId: string;
  contextTokens: number | null;
  contextWindowMax: number | null;
  structuredOutput?: unknown;
  aborted?: boolean;
  /** True when the SDK auto-compacted the context at least once this turn. */
  compacted: boolean;
  abortReason?: "timeout" | "stalled" | "user" | "shutdown";
  timeoutMs?: number;
  error?: string | null;
  /**
   * Summary of the bounded background-task wait the turn performed. Present
   * only when a wait actually occurred (the turn opted in and waitable tasks
   * were in flight); absent otherwise.
   */
  backgroundWait?: BackgroundWaitSummary;
}

async function notifyPromptAccepted(
  options: PromptStreamOptions | undefined,
  sessionName: string,
  conversationId: string,
): Promise<void> {
  if (!options?.onAccepted) return;

  try {
    await options.onAccepted();
  } catch (error) {
    logger.warn("prompt.acceptance_callback_failed", {
      sessionName,
      conversationId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

interface CollabPromptConfig {
  negotiationRounds?: number;
  autonomousResolutionThreshold?: CollaborationAutonomousResolutionThreshold;
}

export class CollabBriefRequiredError extends Error {
  readonly statusCode = 400;
  readonly code = "COLLAB_BRIEF_REQUIRED";
  constructor() {
    super("/collab prompt must include a brief after the slash command");
    this.name = "CollabBriefRequiredError";
  }
}

export class CollabDispatcherUnavailableError extends Error {
  readonly statusCode = 500;
  readonly code = "COLLAB_DISPATCHER_UNAVAILABLE";
  constructor() {
    super(
      "Collaboration dispatcher is not configured for this prompt executor",
    );
    this.name = "CollabDispatcherUnavailableError";
  }
}

export class ConversationCommandDispatcherUnavailableError extends Error {
  readonly statusCode = 500;
  readonly code = "CONVERSATION_COMMAND_DISPATCHER_UNAVAILABLE";
  constructor() {
    super(
      "Conversation command dispatcher is not configured for this prompt executor",
    );
    this.name = "ConversationCommandDispatcherUnavailableError";
  }
}

export function hasCollabPrefix(text: string): boolean {
  const trimmed = text.trimStart();
  return trimmed === "/collab" || trimmed.startsWith("/collab ");
}

export function stripCollabPrefix(text: string): string {
  const trimmed = text.trimStart();
  if (trimmed === "/collab") return "";
  if (trimmed.startsWith("/collab ")) return trimmed.slice("/collab ".length);
  return trimmed;
}

/**
 * Execute a prompt through the conversation lifecycle module.
 *
 * 1. Get-or-create conversation
 * 2. Ensure the conversation lifecycle is ready
 * 3. Execute one turn through its domain interface
 * 4. Emit the terminal stream event from the returned projection
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

  const isCollab = hasCollabPrefix(promptText);
  const parsedCommand = parseConversationCommand(promptText);

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
      resolvedBackend = config.defaultAgentBackend ?? DEFAULT_AGENT_BACKEND_ID;
    }
    const conversation = await resolvedDeps.createConversation(
      projectPath,
      session.sessionName,
      { agentBackend: resolvedBackend },
    );
    conversationId = conversation.id;
  }

  if (parsedCommand) {
    logger.info("prompt.command_detected", {
      entry: "prompt-stream",
      command: parsedCommand.command,
      hintLength: parsedCommand.hint.length,
      sessionName: session.sessionName,
      conversationId,
      modelId: modelId ?? null,
      effort: options?.effort ?? null,
    });
    if (!resolvedDeps.dispatchConversationCommand) {
      logger.error("prompt.command_dispatcher_unavailable", {
        command: parsedCommand.command,
        sessionName: session.sessionName,
        conversationId,
      });
      throw new ConversationCommandDispatcherUnavailableError();
    }
    // The project-conversation entry synthesizes a sentinel session; the
    // service treats that as "no session worktree" (rejection 1.5) while the
    // sentinel still addresses the project scope for the rejection notice.
    const hasSessionWorktree = !isProjectSentinel(session.sessionName);
    try {
      const outcome = await resolvedDeps.dispatchConversationCommand({
        projectPath,
        projectName: resolvedDeps.getProjectDisplayName(projectPath),
        sessionName: hasSessionWorktree ? session.sessionName : null,
        ...(hasSessionWorktree
          ? {}
          : { noticeSessionName: session.sessionName }),
        conversationId,
        parsed: parsedCommand,
        rawText: promptText,
        ...(modelId !== undefined ? { modelId } : {}),
        ...(options?.effort !== undefined ? { effort: options.effort } : {}),
      });
      logger.info("prompt.command_complete", {
        command: parsedCommand.command,
        status: outcome.status,
        sessionName: session.sessionName,
        conversationId,
      });
      await notifyPromptAccepted(options, session.sessionName, conversationId);
      const ticketFallback = ticketCommandFallbackMessage(outcome);
      if (ticketFallback !== null) {
        logger.warn("prompt.command_ticket_fallback", {
          command: parsedCommand.command,
          status: outcome.status,
          sessionName: session.sessionName,
          conversationId,
        });
        emit("error", {
          message: ticketFallback,
        });
      }
      emit("done", {});
      return {
        conversationId,
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Conversation command failed";
      logger.error("prompt.command_failed", {
        command: parsedCommand.command,
        sessionName: session.sessionName,
        conversationId,
        error: errorMsg,
      });
      emitErrorAndDone(emit, errorMsg);
      return {
        conversationId,
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
        error: errorMsg,
      };
    }
  }

  if (isCollab) {
    const brief = stripCollabPrefix(promptText).trim();
    if (brief.length === 0) {
      logger.warn("prompt.collab_brief_required", {
        sessionName: session.sessionName,
        conversationId,
      });
      throw new CollabBriefRequiredError();
    }
    if (!resolvedDeps.dispatchCollabStart) {
      logger.error("prompt.collab_dispatcher_unavailable", {
        sessionName: session.sessionName,
        conversationId,
      });
      throw new CollabDispatcherUnavailableError();
    }
    logger.info("prompt.collab_dispatch", {
      sessionName: session.sessionName,
      conversationId,
      briefLength: brief.length,
      imageCount: images?.length ?? 0,
    });
    try {
      const result = await resolvedDeps.dispatchCollabStart({
        projectPath,
        sessionName: session.sessionName,
        conversationId,
        brief,
        ...(options?.collab?.negotiationRounds !== undefined
          ? { negotiationRounds: options.collab.negotiationRounds }
          : {}),
        ...(options?.collab?.autonomousResolutionThreshold !== undefined
          ? {
              autonomousResolutionThreshold:
                options.collab.autonomousResolutionThreshold,
            }
          : {}),
        ...(modelId !== undefined ? { modelId } : {}),
        ...(options?.effort !== undefined ? { effort: options.effort } : {}),
        ...(images?.length ? { images } : {}),
      });
      await notifyPromptAccepted(options, session.sessionName, conversationId);
      emit("collab-started", {
        workflowId: result.workflowId,
        conversationId,
      });
      emit("done", {});
      return {
        conversationId,
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
      };
    } catch (err) {
      const errorMsg =
        err instanceof Error ? err.message : "Collaboration dispatch failed";
      logger.error("prompt.collab_dispatch_failed", {
        sessionName: session.sessionName,
        conversationId,
        error: errorMsg,
      });
      emitErrorAndDone(emit, errorMsg);
      return {
        conversationId,
        contextTokens: null,
        contextWindowMax: null,
        compacted: false,
        error: errorMsg,
      };
    }
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
        error: getErrorMessage(err),
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
  const actorOptions: {
    executionTarget?: ExecutionTarget;
    actorInput?: EnsureActorInputData;
  } = {};
  if (options?.executionTarget !== undefined) {
    actorOptions.executionTarget = options.executionTarget;
  }
  if (options?.actorInput !== undefined) {
    actorOptions.actorInput = options.actorInput;
  }
  await resolvedDeps.ensureConversationLifecycle(
    projectPath,
    session.sessionName,
    conversationId,
    Object.keys(actorOptions).length > 0 ? actorOptions : undefined,
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

  // Register graph-workflow lane identity so it reaches the session env when the
  // backend runtime is (re)created for this lane conversation.
  if (options?.workflowContext) {
    resolvedDeps.setWorkflowContext?.(
      projectPath,
      session.sessionName,
      conversationId,
      options.workflowContext,
    );
  }

  // Allow validator conversations to bypass the conversation lock
  if (options?.skipConversationLock) {
    resolvedDeps.setSkipConversationLock?.(
      projectPath,
      session.sessionName,
      conversationId,
      true,
    );
  }

  const execution = await resolvedDeps.executeConversationTurn({
    projectPath,
    sessionName: session.sessionName,
    conversationId,
    streamId,
    emit,
    onAccepted: () =>
      notifyPromptAccepted(options, session.sessionName, conversationId),
    turn: {
      promptText,
      images,
      backend: resolvedBackend,
      modelId,
      effort: options?.effort,
      autonomous: options?.autonomous,
      outputFormat: options?.outputFormat,
      ...(options?.waitForBackgroundTasks
        ? { waitForBackgroundTasks: true }
        : {}),
      ...(options?.documentFeedback
        ? { documentFeedback: options.documentFeedback }
        : {}),
      ...(options?.askUserQuestionsEnabled
        ? { askUserQuestionsEnabled: true }
        : {}),
    },
  });

  if (execution.status === "rejected") {
    const errorMessage = "Conversation is not ready to accept a new prompt";
    logger.error("prompt.submit_rejected", {
      conversationId,
      sessionName: session.sessionName,
      reason: execution.reason,
    });
    emitErrorAndDone(emit, errorMessage);
    return {
      conversationId,
      ...execution.result,
      error: errorMessage,
    };
  }

  if (execution.status === "failed") {
    logger.error("prompt.facade_error", {
      sessionName: session.sessionName,
      conversationId,
      error: execution.error,
    });
    emitErrorAndDone(emit, execution.error);
    return {
      conversationId,
      ...execution.result,
      error: execution.result.error ?? execution.error,
    };
  }

  logger.info("prompt.complete", {
    sessionName: session.sessionName,
    conversationId,
  });

  emit("done", {});
  return { conversationId, ...execution.result };
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
 * Emit the terminal SSE pair for a failed prompt request so the client's
 * loading state always resolves.
 */
function emitErrorAndDone(
  emit: (event: string, data: unknown) => void,
  message: string,
): void {
  emit("error", { message });
  emit("done", {});
}
