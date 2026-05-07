/**
 * Extract a human-readable error message from an unknown thrown value.
 *
 * Replaces the repeated pattern:
 *   err instanceof Error ? err.message : String(err)
 */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export type PersistenceFailure =
  | { kind: "validation"; entity: string; identifier?: string; issues: unknown }
  | { kind: "not_found"; entity: string; identifier: string }
  | {
      kind: "constraint";
      constraint: string;
      entity?: string;
      identifier?: string;
    }
  | { kind: "io"; cause: unknown };

export class PersistenceError extends Error {
  constructor(public readonly failure: PersistenceFailure) {
    super(`PersistenceError(${failure.kind})`);
    this.name = "PersistenceError";
  }
}
