/**
 * Types for `cursor-acceptance-gate.mjs`. The implementation is plain ESM
 * because the acceptance launcher runs under bare `node`, with no TypeScript
 * loader — the same constraint that shapes `worker-budget.mjs`.
 */

export type CursorAcceptanceBlockReason = "credential_absent";

export type CursorAcceptanceGate =
  | { state: "ready" }
  | {
      state: "blocked";
      reason: CursorAcceptanceBlockReason;
      message: string;
    };

export declare const CURSOR_ACCEPTANCE_BLOCKED_EXIT_CODE: number;

export declare function resolveCursorAcceptanceGate(env: {
  CURSOR_API_KEY?: string | undefined;
}): CursorAcceptanceGate;

export declare function formatCursorAcceptanceVerdict(
  gate: CursorAcceptanceGate,
): string;
