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
import type { CcTaskSessionScope } from "./task";

export type ContinuityStartInput = ContinuityContext;

export interface ContinuityContext {
  projectPath: string;
  sessionName: string;
  /** Explicit identity for backends with a per-conversation local store. */
  conversationId?: string;
  modelSelection?: BackendModelSelection;
  /** Task cwd when it differs from the project root. */
  workingDirectory?: string;
  /** Task continuation scope; null for tasks without CC API access. */
  taskScope?: CcTaskSessionScope | null;
}

export interface ForkInput {
  projectPath: string;
  /**
   * The fork's own copied transcript: an immutable prefix of the source
   * transcript through the visible fork point, written once before the adapter
   * is called. Its merged message indexes equal the source's. The adapter
   * derives both its native cut and any synthetic seed from this snapshot,
   * never from the source transcript, which can still be growing.
   */
  transcriptSnapshotPath: string;
  /** Last merged message index in the snapshot (inclusive for seed construction). */
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

/**
 * `native` is returned only when the adapter can place its provider cut
 * exactly at the end of the snapshot; `locator` is that cut's opaque provider
 * position, recorded for diagnostics. When no exact cut exists the adapter
 * returns `synthetic_seed` rather than a native fork carrying more or less
 * history than the snapshot shows.
 */
export type ForkOutcome =
  | { kind: "native"; ref: AgentSessionRef; locator: string }
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
