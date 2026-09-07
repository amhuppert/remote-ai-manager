import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import { createLogger } from "@/lib/logging";
import { getErrorMessage } from "@/lib/shared/errors";
import type {
  DesiredRuntimeConfiguration,
  RecreateRuntimeSnapshot,
} from "./pre-turn/runtime-recreate";
import type { ExternalTurnHandler } from "./external-turn-handler";

const logger = createLogger("conversation-runtime");

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

  constructor(private readonly conversationId: string) {}

  get backend(): ConversationBackendRuntime | undefined {
    return this.handle;
  }

  get configurationSnapshot(): RecreateRuntimeSnapshot | undefined {
    if (!this.handle || !this.configuration) return undefined;
    return structuredClone({
      ...this.configuration,
      status: this.handle.status,
    });
  }

  beginCreation(): symbol {
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

  track(work: Promise<void>): Promise<void> {
    this.work.add(work);
    void work.finally(() => this.work.delete(work)).catch(() => {});
    return work;
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
        if (backend) this.index?.unregister(this.conversationId, backend);
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
