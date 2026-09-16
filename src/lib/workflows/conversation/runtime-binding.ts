import type {
  ConversationBackendRuntime,
  ConversationBackendTurnResult,
} from "@/lib/agent-backends/conversation";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type {
  DesiredRuntimeConfiguration,
  RecreateRuntimeSnapshot,
} from "./pre-turn/runtime-recreate";
import type { ExternalTurnHandler } from "./external-turn-handler";

const logger = createLogger("conversation-runtime");
type CleanupFailure = NonNullable<
  ConversationBackendTurnResult["cleanupFailure"]
>;

export interface BackendRuntimeIndex {
  register(conversationId: string, backend: ConversationBackendRuntime): void;
  unregister(conversationId: string, backend: ConversationBackendRuntime): void;
}

/** Owns the backend handle, incarnation and all work required to retire it. */
export class ManagedConversationRuntime {
  mcpApplicationState?: import("@/lib/mcp/schemas").McpRuntimeApplicationState;
  capabilityApplicationState?: import("@/lib/agent-capabilities/schemas").AgentCapabilityRuntimeApplicationState;
  private closing?: { completion: Promise<void>; failed: boolean };
  private handle?: ConversationBackendRuntime;
  private configuration?: DesiredRuntimeConfiguration;
  private incarnation?: symbol;
  private index?: BackendRuntimeIndex;
  private external?: ExternalTurnHandler;
  private readonly work = new Set<Promise<void>>();
  /** Activity of handlers already retired, so the epoch never runs backwards. */
  private retiredActivity = 0;
  private trackedRegistrations = 0;
  private unverifiedCleanup?: CleanupFailure;

  constructor(private readonly conversationId: string) {}

  get backend(): ConversationBackendRuntime | undefined {
    return this.handle;
  }

  get cleanupFailure(): ConversationBackendTurnResult["cleanupFailure"] {
    return this.unverifiedCleanup;
  }

  recordCleanupFailure(failure: CleanupFailure): boolean {
    if (this.unverifiedCleanup) return false;
    this.unverifiedCleanup = { ...failure };
    return true;
  }

  get configurationSnapshot(): RecreateRuntimeSnapshot | undefined {
    if (!this.handle || !this.configuration) return undefined;
    return structuredClone({
      ...this.configuration,
      status: this.handle.status,
    });
  }

  beginCreation(): symbol {
    if (this.unverifiedCleanup) throw new Error(this.unverifiedCleanup.message);
    this.incarnation = Symbol("conversation-backend");
    return this.incarnation;
  }

  isCurrent(incarnation: symbol): boolean {
    return this.incarnation === incarnation;
  }

  install(
    incarnation: symbol,
    backend: ConversationBackendRuntime,
    configuration: DesiredRuntimeConfiguration,
    index: BackendRuntimeIndex,
    external?: ExternalTurnHandler,
  ): void {
    if (this.unverifiedCleanup) throw new Error(this.unverifiedCleanup.message);
    if (!this.isCurrent(incarnation))
      throw new Error("Backend creation lost its host incarnation");
    if (this.handle && this.handle !== backend)
      throw new Error("Retire the hosted backend before replacing it");
    this.closing = undefined;
    this.handle = backend;
    this.configuration = structuredClone(configuration);
    this.index = index;
    this.external = external;
    index.register(this.conversationId, backend);
  }

  /** True while the installed handler has an external turn in flight. */
  get externalTurnActive(): boolean {
    return this.external?.activeTurn ?? false;
  }

  /** Resolves once no external turn is in flight; see `ExternalTurnHandler.settled`. */
  externalTurnSettled(): Promise<void> {
    return this.external?.settled() ?? Promise.resolve();
  }

  /**
   * Monotonic count of owned activity: every accepted external event and
   * every tracked-work registration. Checkpoint maintenance snapshots it after
   * capture and refuses to freeze if it moved, which is how a provider
   * auto-continuation that emitted nothing to the archive still invalidates a
   * build.
   */
  get activityEpoch(): number {
    return (
      this.retiredActivity +
      (this.external?.activity ?? 0) +
      this.trackedRegistrations
    );
  }

  track(work: Promise<void>): Promise<void> {
    this.trackedRegistrations += 1;
    this.work.add(work);
    void work.finally(() => this.work.delete(work)).catch(() => {});
    return work;
  }

  /** Owned asynchronous work (notices, background-loss handling) still pending. */
  get hasTrackedWork(): boolean {
    return this.work.size > 0;
  }

  /**
   * Let every queued external-turn frame reach the archive and every tracked
   * effect settle, without stopping the handler. Checkpoint maintenance calls
   * this before it captures or rechecks the source, so an auto-continuation
   * whose frames were still in flight is seen rather than frozen past.
   */
  async settleOwnedWork(): Promise<void> {
    await this.external?.drain();
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
  }

  close(): Promise<void> {
    if (this.closing) return this.closing.completion;
    const backend = this.handle;
    const close = { completion: Promise.resolve(), failed: false };
    close.completion = Promise.resolve().then(async () => {
      try {
        await backend?.close();
        await this.external?.stopAndDrain();
        while (this.work.size > 0) await Promise.allSettled([...this.work]);
        // A server exit cannot prove its ordinary tool children were reaped.
        if (this.unverifiedCleanup)
          throw new Error(this.unverifiedCleanup.message);
        if (backend) this.index?.unregister(this.conversationId, backend);
        this.retiredActivity += this.external?.activity ?? 0;
        this.handle = undefined;
        this.configuration = undefined;
        this.external = undefined;
        this.incarnation = undefined;
        logger.info("conversation.runtime_closed", {
          conversationId: this.conversationId,
          backend: backend?.backend,
        });
      } catch (error) {
        close.failed = true;
        logger.error("conversation.runtime_close_failed", {
          conversationId: this.conversationId,
          backend: backend?.backend,
          error: getErrorMessage(error),
        });
        throw error;
      }
    });
    this.closing = close;
    return close.completion;
  }

  reconcileClose(): void {
    if (this.closing?.failed) this.closing = undefined;
  }
}
