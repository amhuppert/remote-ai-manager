import { randomUUID } from "node:crypto";
import { createLogger } from "@/lib/logging";
import type { AskQuestionItem } from "@/lib/conversations/schemas";
import {
  IN_TURN_QUESTION_TIMEOUT_MS,
  type InTurnQuestionReply,
} from "@/lib/conversations/in-turn-question-schemas";
import { CURSOR_IPC_CODEC_VERSION, type CursorWorkerFrame } from "./ipc";

const logger = createLogger("cursor-worker:questions");

export class CursorWorkerQuestions {
  private readonly requests = new Map<
    string,
    {
      result: Promise<InTurnQuestionReply>;
      settle(reply: InTurnQuestionReply): void;
    }
  >();
  private closed = false;

  constructor(
    readonly runId: string,
    private readonly send: (frame: CursorWorkerFrame) => void,
    private readonly timeoutMs = IN_TURN_QUESTION_TIMEOUT_MS,
  ) {}

  ask(
    questions: AskQuestionItem[],
    toolCallId?: string,
  ): Promise<InTurnQuestionReply> {
    if (this.closed)
      return Promise.resolve({
        status: "cancelled",
        message: "The requesting run stopped",
      });
    const requestId = toolCallId ?? randomUUID();
    const existing = this.requests.get(requestId);
    if (existing) return existing.result;
    const result = Promise.withResolvers<InTurnQuestionReply>();
    let settled = false;
    const timer = setTimeout(
      () => settle({ status: "expired", message: "The question expired" }),
      this.timeoutMs,
    );
    const settle = (reply: InTurnQuestionReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      logger.info("cursor.question_settled", {
        runId: this.runId,
        requestId,
        status: reply.status,
      });
      result.resolve(reply);
    };
    this.requests.set(requestId, { result: result.promise, settle });
    logger.info("cursor.question_requested", {
      runId: this.runId,
      requestId,
      questionCount: questions.length,
    });
    this.send({
      v: CURSOR_IPC_CODEC_VERSION,
      type: "questionRequest",
      runId: this.runId,
      requestId,
      questions,
    });
    return result.promise;
  }

  answer(runId: string, requestId: string, reply: InTurnQuestionReply): void {
    if (runId !== this.runId || this.closed) return;
    this.requests.get(requestId)?.settle(reply);
  }

  close(): void {
    this.closed = true;
    for (const request of this.requests.values())
      request.settle({
        status: "cancelled",
        message: "The requesting run stopped",
      });
    this.requests.clear();
  }
}
