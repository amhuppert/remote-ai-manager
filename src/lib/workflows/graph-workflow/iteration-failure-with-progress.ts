import { getErrorMessage } from "@/lib/errors";

export class IterationFailureWithProgressError extends Error {
  readonly originalError: unknown;
  readonly completedTurnCount: number;

  constructor(originalError: unknown, completedTurnCount: number) {
    super(getErrorMessage(originalError));
    this.name = "IterationFailureWithProgressError";
    this.originalError = originalError;
    this.completedTurnCount = completedTurnCount;
  }
}

export function hasPartialIterationProgress(error: unknown): boolean {
  return (
    error instanceof IterationFailureWithProgressError &&
    error.completedTurnCount > 0
  );
}
