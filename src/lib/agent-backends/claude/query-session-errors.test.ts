import { describe, expect, it } from "vitest";
import {
  QUERY_SESSION_ERROR_CODES,
  tagQuerySessionError,
  isUndeliveredQuerySessionError,
} from "./query-session-errors";
import { isPromptNotDeliveredFailure } from "../errors";

describe("tagQuerySessionError", () => {
  it("surfaces the neutral prompt-not-delivered fact on promptNotDelivered errors", () => {
    // The adapter is the single capture point: tagging an undelivered prompt
    // must also mark the neutral seam fact so the orchestrator's retry loop
    // never needs this module's Claude-private codes.
    const error = tagQuerySessionError(
      new Error("QuerySession died before prompt delivery"),
      QUERY_SESSION_ERROR_CODES.promptNotDelivered,
    );
    expect(isUndeliveredQuerySessionError(error)).toBe(true);
    expect(isPromptNotDeliveredFailure(error)).toBe(true);
  });

  it("does not mark other query-session codes as prompt-not-delivered", () => {
    const midTurn = tagQuerySessionError(
      new Error("QuerySession died mid turn"),
      QUERY_SESSION_ERROR_CODES.sessionDiedMidTurn,
    );
    const pipe = tagQuerySessionError(
      new Error("SDK pipe broke"),
      QUERY_SESSION_ERROR_CODES.sdkPipeBroken,
    );
    expect(isPromptNotDeliveredFailure(midTurn)).toBe(false);
    expect(isPromptNotDeliveredFailure(pipe)).toBe(false);
  });
});
