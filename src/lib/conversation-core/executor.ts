import { randomUUID } from "node:crypto";
import type { ControlPermits } from "@/lib/control/permits";
import type { PermitRef } from "@/lib/control/schemas";
import type { Executor, OperationState } from "@/lib/intents/executor";
import type { OwnerRef, PendingIntent } from "@/lib/intents/schemas";
import type { Logger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type { ConversationCoreRepo } from "@/lib/state-store/conversation-core-repo";
import type { Grant, GrantRequest, WorkspaceAdmission } from "@/lib/workspace/admission";
import {
  seatTurnRequestSchema,
  type MailboxItemRecord,
  type SeatBindingRecord,
  type SeatTurnReport,
  type SeatTurnRequest,
} from "./schemas";

/** What one admitted seat turn produced, before settlement records it. */
export interface SeatTurnResult {
  status: "succeeded" | "failed" | "cancelled" | "interrupted";
  finalText: string | null;
  structuredOutput: unknown;
  outputIssue: string | null;
  failure: string | null;
  backendRef: string | null;
}

/** Runtime binding and dispatch for one admitted seat turn. */
export interface SeatTurnPort {
  run(input: {
    conversationId: string;
    binding: SeatBindingRecord;
    request: SeatTurnRequest;
    attemptId: string;
    signal: AbortSignal;
  }): Promise<SeatTurnResult>;
}

export interface ConversationCoreDeps {
  transaction<T>(fn: () => T): T;
  repo: ConversationCoreRepo;
  permits: ControlPermits;
  admission: WorkspaceAdmission;
  createSeatConversation(input: {
    projectPath: string;
    sessionName: string;
    role: "implementer" | "reviewer";
    request: SeatTurnRequest;
  }): Promise<string>;
  turns: SeatTurnPort;
  /** Model capacity, taken together with the workspace grant and never waited on while holding it. */
  slots: {
    tryAcquire(label: string): Promise<(() => void) | null>;
    waitForRelease(signal?: AbortSignal): Promise<void>;
  };
  questions: { openedDuring(conversationId: string, attemptId: string): string | null };
  touchRequester(owner: OwnerRef): void;
  now(): string;
  /** How often a blocked acquisition re-checks its permit; permits carry no change signal. */
  permitPollMs?: number;
  log: Pick<Logger, "info" | "warn" | "error">;
}

/**
 * The Conversation core for supervised seat conversations. Every requested turn
 * enters the mailbox; one turn lifetime per conversation selects it, opens an
 * attempt, acquires permit, workspace grant and model capacity together, runs
 * it, and settles it through the single terminal recorder.
 */
export interface ConversationCore extends Executor {
  /** Boot: admitted attempts settle as interrupted; unadmitted ones return to the queue. */
  recover(): void;
  /** Resolves once no turn is running or waiting to start. */
  idle(): Promise<void>;
  seatBinding(conversationId: string): SeatBindingRecord | null;
  /** The attempt a conversation is running now, for questions it asks. */
  runningAttempt(conversationId: string): string | null;
}

type Acquired =
  | { kind: "admitted"; grant: Grant | null; releaseSlot: () => void }
  | { kind: "not_admitted"; reason: string };

function grantFor(request: SeatTurnRequest, holder: string): GrantRequest | null {
  const { worktreePath, access, scope } = request.workspace;
  switch (access) {
    case "observe":
      return null;
    case "stable_read":
      return { worktree: worktreePath, kind: "stable_read", holder };
    case "write":
      if (scope.mode === "owned") {
        return { worktree: worktreePath, kind: "scoped_write", paths: scope.paths, holder };
      }
      return scope.mode === "full" ? { worktree: worktreePath, kind: "full_write", holder } : null;
  }
}

export function createConversationCore(deps: ConversationCoreDeps): ConversationCore {
  const runners = new Map<string, Promise<void>>();
  const rerun = new Set<string>();
  const controllers = new Map<string, AbortController>();
  const runningAttempts = new Map<string, string>();
  const pollMs = deps.permitPollMs ?? 1000;

  function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  async function acquire(
    item: MailboxItemRecord,
    request: SeatTurnRequest,
    signal: AbortSignal,
  ): Promise<Acquired> {
    const grantRequest = grantFor(request, item.cause);
    for (;;) {
      if (signal.aborted) return { kind: "not_admitted", reason: "cancelled before admission" };
      const current = deps.repo.getMailbox(item.cause);
      const permit: PermitRef | null = current?.permit ?? item.permit;
      if (!deps.permits.admits(permit)) {
        return { kind: "not_admitted", reason: "the permit is closed" };
      }
      const grant = grantRequest === null ? null : deps.admission.tryAcquire(grantRequest);
      if (grantRequest !== null && grant === null) {
        await Promise.race([deps.admission.waitForChange(signal), sleep(pollMs, signal)]);
        continue;
      }
      const releaseSlot = await deps.slots.tryAcquire(`seat:${item.conversationId}`);
      if (releaseSlot === null) {
        // Never hold a workspace grant while waiting for model capacity.
        if (grant !== null) deps.admission.release(grant);
        await Promise.race([deps.slots.waitForRelease(signal), sleep(pollMs, signal)]);
        continue;
      }
      // Re-check the permit at the moment of admission, with the bundle in hand.
      if (!deps.permits.admits(deps.repo.getMailbox(item.cause)?.permit ?? permit)) {
        releaseSlot();
        if (grant !== null) deps.admission.release(grant);
        return { kind: "not_admitted", reason: "the permit is closed" };
      }
      return { kind: "admitted", grant, releaseSlot };
    }
  }

  async function ensureSeat(request: SeatTurnRequest): Promise<SeatBindingRecord> {
    const { seat, workspace } = request;
    const existing = deps.repo.findSeat(seat.contextId, seat.assignmentId, seat.replacement);
    if (existing !== null) return existing;
    const conversationId = await deps.createSeatConversation({
      projectPath: workspace.projectPath,
      sessionName: workspace.sessionName,
      role: seat.role,
      request,
    });
    deps.transaction(() =>
      deps.repo.insertSeat({
        conversationId,
        contextId: seat.contextId,
        assignmentId: seat.assignmentId,
        replacement: seat.replacement,
        role: seat.role,
        projectPath: workspace.projectPath,
        sessionName: workspace.sessionName,
        backend: seat.assignment.backend,
        backendRef: null,
        createdAt: deps.now(),
        updatedAt: deps.now(),
      }),
    );
    const created = deps.repo.findSeat(seat.contextId, seat.assignmentId, seat.replacement);
    if (created === null) throw new Error(`Seat ${seat.contextId}/${seat.assignmentId} was not recorded`);
    return created;
  }

  /** The single terminal recorder for an opened attempt. */
  function settleAttempt(
    item: MailboxItemRecord,
    attemptId: string,
    result: SeatTurnResult,
  ): void {
    const report: SeatTurnReport = {
      status: result.status,
      conversationId: item.conversationId,
      finalText: result.finalText,
      structuredOutput: result.structuredOutput,
      outputIssue: result.outputIssue,
      openQuestionId: deps.questions.openedDuring(item.conversationId, attemptId),
      failure: result.failure,
    };
    deps.transaction(() => {
      deps.repo.settleAttempt(attemptId, report, deps.now());
      deps.repo.consumeMailbox(item.cause, attemptId, deps.now());
      if (result.backendRef !== null) {
        deps.repo.setSeatBackendRef(item.conversationId, result.backendRef, deps.now());
      }
    });
  }

  /** One turn lifetime: every exit after `open` records exactly one terminal. */
  async function runTurn(item: MailboxItemRecord): Promise<"settled" | "not_admitted"> {
    const request = seatTurnRequestSchema.parse(item.request);
    const attemptId = randomUUID();
    deps.transaction(() =>
      deps.repo.insertAttempt({
        attemptId,
        conversationId: item.conversationId,
        cause: item.cause,
        state: "open",
        outcome: null,
        openedAt: deps.now(),
        settledAt: null,
      }),
    );
    const controller = new AbortController();
    controllers.set(item.cause, controller);
    try {
      const acquired = await acquire(item, request, controller.signal);
      if (acquired.kind === "not_admitted") {
        deps.transaction(() =>
          deps.repo.settleAttempt(attemptId, { notAdmitted: acquired.reason }, deps.now()),
        );
        return "not_admitted";
      }
      deps.transaction(() => deps.repo.admitAttempt(attemptId));
      runningAttempts.set(item.conversationId, attemptId);
      let result: SeatTurnResult;
      try {
        const binding = deps.repo.getSeat(item.conversationId);
        if (binding === null) throw new Error(`Seat conversation ${item.conversationId} has no binding`);
        result = await deps.turns.run({
          conversationId: item.conversationId,
          binding,
          request,
          attemptId,
          signal: controller.signal,
        });
      } catch (error) {
        result = {
          status: controller.signal.aborted ? "cancelled" : "failed",
          finalText: null,
          structuredOutput: null,
          outputIssue: null,
          failure: getErrorMessage(error),
          backendRef: null,
        };
      } finally {
        runningAttempts.delete(item.conversationId);
        acquired.releaseSlot();
        if (acquired.grant !== null) deps.admission.release(acquired.grant);
      }
      settleAttempt(item, attemptId, result);
      deps.touchRequester(item.requester);
      return "settled";
    } finally {
      controllers.delete(item.cause);
    }
  }

  async function drainConversation(conversationId: string): Promise<void> {
    for (;;) {
      rerun.delete(conversationId);
      const item = deps.repo.nextQueued(conversationId);
      if (item === null) return;
      const result = await runTurn(item).catch((error) => {
        deps.log.error("conversation_core.turn_failed", {
          conversationId,
          cause: item.cause,
          error: getErrorMessage(error),
        });
        return "not_admitted" as const;
      });
      // An unadmitted item waits for a resubmission under a fresh permit.
      if (result === "not_admitted" && !rerun.has(conversationId)) return;
    }
  }

  function wake(conversationId: string): void {
    if (runners.has(conversationId)) {
      rerun.add(conversationId);
      return;
    }
    const runner = drainConversation(conversationId).finally(() => {
      runners.delete(conversationId);
      if (rerun.has(conversationId)) wake(conversationId);
    });
    runners.set(conversationId, runner);
  }

  return {
    async submit(intent: PendingIntent) {
      const request = seatTurnRequestSchema.parse(intent.request);
      const existing = deps.repo.getMailbox(intent.cause);
      if (existing !== null) {
        if (existing.state === "queued") {
          // A resubmission refreshes the permit of an item not yet admitted.
          deps.transaction(() => deps.repo.refreshMailboxPermit(intent.cause, intent.permit, deps.now()));
          wake(existing.conversationId);
        }
        return;
      }
      const seat = await ensureSeat(request);
      deps.transaction(() =>
        deps.repo.insertMailboxIfAbsent({
          cause: intent.cause,
          conversationId: seat.conversationId,
          requester: intent.requester,
          request: intent.request,
          permit: intent.permit,
          state: "queued",
          attemptId: null,
          createdAt: deps.now(),
          updatedAt: deps.now(),
        }),
      );
      wake(seat.conversationId);
    },
    outcome(cause): OperationState {
      const item = deps.repo.getMailbox(cause);
      if (item === null) return { kind: "unknown" };
      if (item.state === "consumed" && item.attemptId !== null) {
        const attempt = deps.repo.getAttempt(item.attemptId);
        return { kind: "settled", outcome: attempt?.outcome ?? null };
      }
      const attempt = deps.repo.latestAttemptFor(cause);
      return attempt !== null && attempt.state === "admitted" ? { kind: "running" } : { kind: "queued" };
    },
    withdraw(cause) {
      const attempt = deps.repo.latestAttemptFor(cause);
      if (attempt !== null && attempt.state === "admitted") return;
      controllers.get(cause)?.abort();
      deps.transaction(() => deps.repo.deleteMailbox(cause));
    },
    interrupt(cause) {
      controllers.get(cause)?.abort();
    },
    recover() {
      deps.transaction(() => {
        for (const attempt of deps.repo.attemptsInState("admitted")) {
          const report: SeatTurnReport = {
            status: "interrupted",
            conversationId: attempt.conversationId,
            finalText: null,
            structuredOutput: null,
            outputIssue: null,
            openQuestionId: null,
            failure: "The server restarted while this turn was running",
          };
          deps.repo.settleAttempt(attempt.attemptId, report, deps.now());
          deps.repo.consumeMailbox(attempt.cause, attempt.attemptId, deps.now());
        }
        for (const attempt of deps.repo.attemptsInState("open")) {
          deps.repo.settleAttempt(attempt.attemptId, { notAdmitted: "the server restarted before admission" }, deps.now());
        }
      });
    },
    async idle() {
      while (runners.size > 0) await Promise.all([...runners.values()]);
    },
    seatBinding(conversationId) {
      return deps.repo.getSeat(conversationId);
    },
    runningAttempt(conversationId) {
      return runningAttempts.get(conversationId) ?? null;
    },
  };
}
