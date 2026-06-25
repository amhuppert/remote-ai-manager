/**
 * SessionToolsSupervisor — owns the recovery lifecycle of the in-process
 * (`type: "sdk"`) `cc-session-tools` MCP binding for one Claude runtime.
 *
 * The in-process transport can go stale/closed while the long-lived `Query`
 * is still alive, after which every `mcp__cc-session-tools__*` call returns the
 * SDK-synthesized "Stream closed" error and the real handler never runs. The
 * only working repair is the two-phase remove-then-add rebind (the SDK diffs
 * `sdk` servers by NAME, so a same-name swap is a silent no-op); the supervisor
 * is the single place that decides WHEN to rebind, WHETHER it is safe, and WHEN
 * to give up and ask the actor to recreate the runtime.
 *
 * Two entry points:
 *  - `ensureReady("turn_start")` — the pre-turn contract. For a reused runtime
 *    it forces an unconditional rebind BEFORE the prompt is delivered (the
 *    disconnect window is safe — no tool call is in flight). This is the
 *    primary fix: the observed failure cannot occur on a reused turn without a
 *    successful rebind first.
 *  - `onStreamClosed(info)` — the reactive state machine. A reactive rebind
 *    cannot save the already-failed call (the SDK already returned "Stream
 *    closed"); it repairs the binding so the agent's retry/next call succeeds.
 *    Mid-turn robustness is best-effort — CC does not control the agent loop.
 *
 * The supervisor never tears the runtime down itself; on an unrecoverable
 * failure it asks the owner to kill/recreate (`escalateToKill`).
 */

import type { Logger } from "@/lib/logging";
import type { EnsureReadyReason, ReadyResult } from "../conversation";
import type { SdkMcpStreamClosedInfo } from "./query-session";

export type SessionToolsHealth = "healthy" | "unhealthy" | "dead";

export interface SessionToolsSupervisorDeps {
  /** Conversation id, attached to every telemetry event for correlation. */
  conversationId: string;
  /**
   * Perform the two-phase remove-then-add rebind of the `cc-session-tools`
   * sdk server (production wraps `ClaudeConversationRuntime.replaceSessionToolsInstance`).
   * Rejects on failure.
   */
  rebind(): Promise<void>;
  /** True iff a turn is blocked on a validly pending AskUserQuestion resolver. */
  isQuestionPending(): boolean;
  /** True iff the underlying runtime / query session is dead. */
  isDead(): boolean;
  /**
   * Force-terminate the live turn because in-process recovery is unrecoverable
   * this turn, so the actor's get-or-create path builds a fresh (resumed)
   * runtime on the next prompt. Supersedes the generic stream-closed threshold.
   * Must be idempotent.
   */
  escalateToKill(reason: string): void;
  /** Injected clock (ms) for telemetry durations. */
  now(): number;
  logger: Logger;
}

export interface SessionToolsSupervisor {
  /**
   * Pre-turn readiness. Resets per-turn state on a `turn_start`, then forces a
   * rebind for a reused runtime. Returns `recreate-runtime` when the binding
   * cannot be repaired (or the runtime is already dead).
   */
  ensureReady(reason: EnsureReadyReason): Promise<ReadyResult>;
  /** Reactive entry: a `cc-session-tools` tool call came back "Stream closed". */
  onStreamClosed(info: SdkMcpStreamClosedInfo): void;
  /** Mark the binding unhealthy for telemetry (e.g. a status probe failure). */
  markUnhealthy(reason: string): void;
  health(): SessionToolsHealth;
}

type RebindOutcome = { ok: true } | { ok: false; error: string };

export function createSessionToolsSupervisor(
  deps: SessionToolsSupervisorDeps,
): SessionToolsSupervisor {
  let health: SessionToolsHealth = "healthy";
  let rebindInFlight: Promise<RebindOutcome> | null = null;
  let closesThisTurn = 0;
  // The runtime's initial bind (init()) freshly connected the in-process
  // server, so the first turn does not need a rebind; reused turns do.
  let firstEnsure = true;

  function logFields(extra: Record<string, unknown>): Record<string, unknown> {
    return { conversationId: deps.conversationId, ...extra };
  }

  async function doRebind(reason: string): Promise<RebindOutcome> {
    const startedAt = deps.now();
    deps.logger.info("session_tools.refresh_started", logFields({ reason }));
    try {
      await deps.rebind();
      if (health !== "dead") {
        health = "healthy";
      }
      deps.logger.info(
        "session_tools.refresh_succeeded",
        logFields({
          reason,
          durationMs: deps.now() - startedAt,
          health,
        }),
      );
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      deps.logger.error(
        "session_tools.refresh_failed",
        logFields({ reason, error, durationMs: deps.now() - startedAt }),
      );
      return { ok: false, error };
    }
  }

  /**
   * Single-flight: a rebind already running (e.g. a pre-turn `ensureReady`)
   * is joined rather than duplicated when `onStreamClosed` fires. Replaces the
   * former wall-clock debounce with structural single-flight.
   */
  function runRebind(reason: string): Promise<RebindOutcome> {
    if (rebindInFlight) return rebindInFlight;
    const p = doRebind(reason);
    rebindInFlight = p;
    void p.finally(() => {
      if (rebindInFlight === p) rebindInFlight = null;
    });
    return p;
  }

  function escalate(reason: string): void {
    if (health === "dead") return;
    health = "dead";
    deps.logger.error("session_tools.escalate_kill", logFields({ reason }));
    deps.escalateToKill(reason);
  }

  function markUnhealthy(reason: string): void {
    if (health === "dead") return;
    if (health === "healthy") {
      deps.logger.warn("session_tools.marked_unhealthy", logFields({ reason }));
    }
    health = "unhealthy";
  }

  async function ensureReady(reason: EnsureReadyReason): Promise<ReadyResult> {
    // A `turn_start` is the per-turn boundary; reset the close counter so a
    // close in a prior turn cannot count toward this turn's 2-strike kill.
    if (reason === "turn_start") closesThisTurn = 0;

    if (deps.isDead()) {
      health = "dead";
      return { status: "recreate-runtime", reason: "runtime_dead" };
    }

    if (deps.isQuestionPending()) {
      // Pending-question guard: never disrupt a validly pending question with a
      // proactive rebind. (Anomalous pre-turn — a turn is normally idle here.)
      deps.logger.info(
        "session_tools.ensure_skipped_question_pending",
        logFields({ reason }),
      );
      return { status: "ready" };
    }

    if (firstEnsure) {
      firstEnsure = false;
      health = "healthy";
      return { status: "ready" };
    }

    const outcome = await runRebind(reason);
    if (outcome.ok) return { status: "ready" };
    return {
      status: "recreate-runtime",
      reason: `session_tools_rebind_failed: ${outcome.error}`,
    };
  }

  function onStreamClosed(info: SdkMcpStreamClosedInfo): void {
    if (deps.isDead()) {
      health = "dead";
      return;
    }

    closesThisTurn += 1;
    deps.logger.warn(
      "session_tools.stream_closed",
      logFields({
        toolName: info.toolName,
        serverName: info.serverName,
        closesThisTurn,
        questionPending: deps.isQuestionPending(),
      }),
    );

    // A second close this turn (after a rebind attempt) means the binding is
    // unrecoverable this turn. Kill now so the agent is not left making
    // repeated doomed cc-session-tools calls. This supersedes the generic
    // consecutive-stream-closed threshold, which never fires for this server.
    if (closesThisTurn >= 2) {
      escalate("second_stream_closed_this_turn");
      return;
    }

    markUnhealthy("stream_closed");
    void runRebind("stream_closed").then((outcome) => {
      if (!outcome.ok) escalate("rebind_failed");
    });
  }

  return {
    ensureReady,
    onStreamClosed,
    markUnhealthy,
    health: () => health,
  };
}
