export const QUERY_SESSION_ERROR_CODES = {
  promptNotDelivered: "query_session_prompt_not_delivered",
  sessionDiedMidTurn: "SESSION_DIED_MID_TURN",
  sdkPipeBroken: "SDK_PIPE_BROKEN",
} as const;

export type QuerySessionErrorCode =
  (typeof QUERY_SESSION_ERROR_CODES)[keyof typeof QUERY_SESSION_ERROR_CODES];

export function tagQuerySessionError<T extends Error>(
  error: T,
  code: QuerySessionErrorCode,
): T & { code: QuerySessionErrorCode } {
  (error as T & { code: QuerySessionErrorCode }).code = code;
  return error as T & { code: QuerySessionErrorCode };
}

function hasQuerySessionErrorCode(
  error: unknown,
  code: QuerySessionErrorCode,
): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (error as Error & { code?: string }).code === code;
}

export function isUndeliveredQuerySessionError(error: unknown): boolean {
  return hasQuerySessionErrorCode(
    error,
    QUERY_SESSION_ERROR_CODES.promptNotDelivered,
  );
}

export function isSessionDiedMidTurnError(error: unknown): boolean {
  return hasQuerySessionErrorCode(
    error,
    QUERY_SESSION_ERROR_CODES.sessionDiedMidTurn,
  );
}

export function isSdkPipeBrokenError(error: unknown): boolean {
  return hasQuerySessionErrorCode(
    error,
    QUERY_SESSION_ERROR_CODES.sdkPipeBroken,
  );
}
