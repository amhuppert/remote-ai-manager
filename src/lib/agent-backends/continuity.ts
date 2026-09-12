/**
 * Backend continuity seam: session/thread lifecycle as an adapter-owned
 * operation set. Consumers ask the owning backend's adapter to start,
 * validate, resume, or fork a continuity handle and act on the normalized
 * result — backend identity never branches above this seam. The `ref` inside
 * an `AgentSessionRef` is opaque: only the adapter that minted it may
 * interpret it, and every adapter rejects a ref whose `backend` field does
 * not match its own id.
 */

import type { AgentBackendId, AgentSessionRef } from "@/lib/shared/schemas";
import type { BackendModelSelection } from "./schemas";

export type ContinuityStartInput = ContinuityContext;

export interface ContinuityContext {
  projectPath: string;
  sessionName: string;
  /** Explicit identity for backends with a per-conversation local store. */
  conversationId?: string;
  modelSelection?: BackendModelSelection;
  /** Task cwd when it differs from the project root. */
  workingDirectory?: string;
}

export interface ForkInput {
  projectPath: string;
  /**
   * Backend-native fork anchor (e.g. a transcript message uuid) locating the
   * precise fork point. Null when no anchor could be derived — adapters with
   * native fork must NOT fork without one (an unanchored native fork silently
   * carries the full source history past the visible fork point).
   */
  anchorMessageId: string | null;
  /** CC-local transcript of the source conversation, for seed construction. */
  sourceTranscriptPath: string;
  /** Fork point in the CC transcript (inclusive for seed construction). */
  messageIndex: number;
}

export type ContinuityValidation =
  | { status: "valid" }
  | { status: "stale"; reason: string };

export interface ContinuityResumption {
  ref: AgentSessionRef;
  /** True when the original handle was stale and a fresh one was created. */
  recovered: boolean;
}

export type ForkOutcome =
  | { kind: "native"; ref: AgentSessionRef }
  | { kind: "synthetic_seed"; seed: string }
  | { kind: "unsupported" };

export interface BackendContinuityAdapter {
  readonly backend: AgentBackendId;
  start(input: ContinuityStartInput): Promise<AgentSessionRef>;
  /** Cheap liveness/validity check for a persisted ref. */
  validate(
    ref: AgentSessionRef,
    input: ContinuityContext,
  ): Promise<ContinuityValidation>;
  /** Resume if possible, otherwise recover (new handle per backend policy). */
  resumeOrRecover(
    ref: AgentSessionRef,
    input: ContinuityContext,
  ): Promise<ContinuityResumption>;
  fork(ref: AgentSessionRef, input: ForkInput): Promise<ForkOutcome>;
}

/** A continuity operation received a ref owned by a different backend. */
export class ContinuityRefMismatchError extends Error {
  readonly expectedBackend: AgentBackendId;
  readonly actualBackend: AgentBackendId;

  constructor(expectedBackend: AgentBackendId, actualBackend: AgentBackendId) {
    super(
      `Continuity adapter for "${expectedBackend}" received a ref owned by "${actualBackend}"`,
    );
    this.name = "ContinuityRefMismatchError";
    this.expectedBackend = expectedBackend;
    this.actualBackend = actualBackend;
  }
}

/**
 * Fork could not produce any outcome: the native path (when attempted) and
 * the synthetic-seed path both failed. Callers map this to their typed
 * creation error — no fork artifact may be persisted.
 */
export class ContinuityForkError extends Error {
  readonly backend: AgentBackendId;
  readonly cause?: unknown;

  constructor(
    backend: AgentBackendId,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message);
    this.name = "ContinuityForkError";
    this.backend = backend;
    this.cause = options.cause;
  }
}

export function assertRefOwnedBy(
  backend: AgentBackendId,
  ref: AgentSessionRef,
): void {
  if (ref.backend !== backend) {
    throw new ContinuityRefMismatchError(backend, ref.backend);
  }
}

/** Returns the opaque value only when the ref belongs to `backend`. */
export function refValueForBackend(
  ref: AgentSessionRef | null | undefined,
  backend: AgentBackendId,
): string | undefined {
  return ref?.backend === backend ? ref.ref : undefined;
}
