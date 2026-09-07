import { randomUUID } from "node:crypto";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import { QuerySlotAdmissionTimeoutError } from "@/lib/shared/query-semaphore";
import { BackendAdmissionError } from "@/lib/agent-backends/execution-admission";
import type { AgentCallResult } from "@/lib/workflows/primitives/agent-call-vocabulary";
import type { AdmittedConversationProfile } from "@/lib/conversations/profile-admission";
import type { ConversationContext, PromptActorResult } from "./types";
import type {
  SettledConversationTurn,
  TurnExecutionOutcome,
  TurnInterruption,
} from "./turn-result";
import type {
  ConversationExecutionContext,
  TurnCancelReason,
} from "./turn-spec";

const logger = createLogger("conversation.turn-attempt");

export class TurnAttempt {
  readonly attemptId = randomUUID();
  readonly controller = new AbortController();
  readonly completed: Promise<SettledConversationTurn>;
  readonly executionContext: ConversationExecutionContext;
  readonly profile: AdmittedConversationProfile | undefined;
  private resolveCompletion!: (turn: SettledConversationTurn) => void;
  private readonly work: Promise<unknown>[] = [];
  private readonly releases: (() => void)[] = [];
  private readonly receipts: (() => Promise<void>)[] = [];
  private readonly disposers: (() => void)[] = [];
  private readonly unfinished: {
    code: "runtime_close" | "delivery_receipt";
    run(): Promise<void>;
  }[] = [];
  private closePromise?: Promise<void>;
  private settlement?: Promise<void>;
  private outcome?: TurnExecutionOutcome;
  private finished = false;
  private cancellation?: TurnCancelReason;
  projectedResult?: PromptActorResult;

  constructor(
    private readonly options: {
      conversationId: string;
      executionContext?: ConversationExecutionContext;
      profile?: AdmittedConversationProfile;
      isCurrent(): boolean;
      onCancel(reason: TurnCancelReason, attemptId: string): void;
      closeRuntime(): Promise<void>;
    },
  ) {
    this.executionContext = options.executionContext ?? {};
    this.profile = options.profile;
    this.completed = new Promise((resolve) => {
      this.resolveCompletion = resolve;
    });
    this.controller.signal.addEventListener(
      "abort",
      () => {
        if (this.finished || !options.isCurrent()) return;
        const reason: unknown = this.controller.signal.reason;
        this.cancellation ??=
          reason === "timeout" || reason === "stalled" || reason === "shutdown"
            ? reason
            : "user";
        void this.closeBackend();
        logger.info("turn.cancel_requested", {
          conversationId: options.conversationId,
          attemptId: this.attemptId,
          reason: this.cancellation,
        });
        options.onCancel(this.cancellation, this.attemptId);
      },
      { once: true },
    );
  }

  isCurrent(): boolean {
    return !this.finished && this.options.isCurrent();
  }

  cancel = (reason: TurnCancelReason): Promise<SettledConversationTurn> => {
    if (this.finished || !this.options.isCurrent()) return this.completed;
    this.cancellation ??= reason;
    this.controller.abort(reason);
    return this.completed;
  };

  track<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const cancel = () => {
      void this.cancel("user");
    };
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    // Enrol before invoking asynchronous preparation, including lazy imports.
    const execution = Promise.resolve().then(run);
    this.work.push(execution);
    void execution.then(
      () => signal?.removeEventListener("abort", cancel),
      (error) => {
        signal?.removeEventListener("abort", cancel);
        this.recordFailure(error);
      },
    );
    return execution;
  }

  closeBackend(): Promise<void> {
    this.closePromise = Promise.resolve().then(() =>
      this.options.closeRuntime(),
    );
    void this.closePromise.catch(() => {});
    return this.closePromise;
  }

  recordResult(result: AgentCallResult, interruption?: TurnInterruption): void {
    const detail =
      interruption ??
      (this.cancellation ? { reason: this.cancellation } : undefined);
    this.outcome = {
      kind: "call_result",
      result,
      ...(detail ? { interruption: detail } : {}),
    };
  }

  recordFailure(error: unknown): void {
    if (this.outcome?.kind === "call_result") return;
    this.outcome = {
      kind: "not_started",
      reason: this.controller.signal.aborted
        ? "cancelled"
        : error instanceof QuerySlotAdmissionTimeoutError
          ? "query_slot_timeout"
          : error instanceof BackendAdmissionError
            ? "backend_admission"
            : "configuration",
      message: getErrorMessage(error),
      ...(error instanceof BackendAdmissionError
        ? { admission: error.refusal }
        : {}),
      ...(this.cancellation ? { cancelReason: this.cancellation } : {}),
    };
  }

  ownRelease(release: () => void): void {
    this.releases.push(release);
  }

  ownReceipt(finish: () => Promise<void>): void {
    this.receipts.push(finish);
  }

  ownDisposer(dispose: () => void): void {
    this.disposers.push(dispose);
  }

  settle(): Promise<void> {
    this.settlement ??= this.settleOwnedWork();
    return this.settlement;
  }

  get hasUnreconciledWork(): boolean {
    return this.unfinished.length > 0;
  }
  get requiresCloseRetry(): boolean {
    return this.unfinished.some((work) => work.code === "runtime_close");
  }
  get settlementError(): Error | undefined {
    return this.outcome?.kind === "settlement_failed"
      ? new Error(this.outcome.message)
      : undefined;
  }

  async reconcile(): Promise<void> {
    const failures: unknown[] = [];
    for (const work of [...this.unfinished]) {
      try {
        await work.run();
        this.unfinished.splice(this.unfinished.indexOf(work), 1);
      } catch (error) {
        failures.push(error);
        this.failSettlement(work.code, error);
      }
    }
    if (failures.length) throw failures[0];
  }

  private async settleOwnedWork(): Promise<void> {
    await Promise.allSettled(this.work);
    try {
      await this.closePromise;
    } catch (error) {
      this.unfinished.push({
        code: "runtime_close",
        run: () => this.closeBackend(),
      });
      this.failSettlement("runtime_close", error);
    }
    for (const finish of this.receipts) {
      try {
        await finish();
      } catch (error) {
        this.unfinished.push({ code: "delivery_receipt", run: finish });
        this.failSettlement("delivery_receipt", error);
      }
    }
    for (const dispose of [...this.releases.reverse(), ...this.disposers]) {
      try {
        dispose();
      } catch (error) {
        this.unfinished.push({
          code: "runtime_close",
          run: async () => {
            dispose();
          },
        });
        this.failSettlement("runtime_close", error);
      }
    }
    this.releases.length = 0;
    this.disposers.length = 0;
  }

  failSettlement(
    code: "runtime_close" | "delivery_receipt" | "persistence",
    error: unknown,
  ): void {
    const result =
      this.outcome?.kind === "call_result" ||
      this.outcome?.kind === "settlement_failed"
        ? this.outcome.result
        : null;
    this.outcome = {
      kind: "settlement_failed",
      ...(this.outcome?.interruption
        ? { interruption: this.outcome.interruption }
        : {}),
      code,
      result,
      message: getErrorMessage(error),
    };
    logger.error("turn.settlement_failed", {
      conversationId: this.options.conversationId,
      attemptId: this.attemptId,
      code,
      error: getErrorMessage(error),
    });
  }

  complete(
    context: Pick<
      ConversationContext,
      "status" | "pendingQuestion" | "lastError"
    >,
  ): void {
    if (this.finished) return;
    this.finished = true;
    this.outcome ??= {
      kind: "not_started",
      reason: this.cancellation ? "cancelled" : "configuration",
      message:
        context.lastError ??
        this.projectedResult?.error ??
        (this.cancellation
          ? "Turn cancelled"
          : "Turn ended without an execution result"),
      ...(this.cancellation ? { cancelReason: this.cancellation } : {}),
    };
    logger.info("turn.settled", {
      conversationId: this.options.conversationId,
      attemptId: this.attemptId,
      outcome: this.outcome.kind,
    });
    this.resolveCompletion({
      attemptId: this.attemptId,
      outcome: this.outcome,
      status: context.status,
      pendingQuestion: context.pendingQuestion,
    });
  }
}
