import type {
  MessageContentBlock,
  AskQuestionItem,
  ImagePayload,
} from "@/types";
import type {
  AgentBackendId,
  AgentSessionRef,
  ConversationBackendCapabilities,
  ConversationToolingOverrides,
} from "./types";
import type { PortableMcpConfig, McpApplyResult } from "./portable-mcp";

export type ConversationBackendEvent =
  | { type: "backend_init"; backendRef: AgentSessionRef }
  | { type: "content"; block: MessageContentBlock }
  | { type: "provider_event"; payload: unknown }
  | { type: "error"; message: string }
  | { type: "external_turn_started" }
  | {
      type: "external_turn_completed";
      result: ConversationBackendTurnResult;
    };

export interface ConversationBackendTurnInput {
  promptText: string;
  images: ImagePayload[];
  sessionInstructions: string[];
  modelId?: string;
  reasoningEffort?: string;
  autonomous: boolean;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  signal: AbortSignal;
  onEvent(event: ConversationBackendEvent): Promise<void> | void;
  onAskQuestion?(questions: AskQuestionItem[]): Promise<Record<string, string>>;
  nativeFork?: {
    sourceRef: AgentSessionRef;
    forkLocator?: string | null;
  } | null;
  syntheticForkSeed?: string | null;
}

export interface ConversationBackendTurnResult {
  backendRef: AgentSessionRef | null;
  costUsd: number | null;
  durationMs: number | null;
  numTurns: number | null;
  contextTokens: number | null;
  contextWindowMax: number | null;
  contentBlocks: MessageContentBlock[];
  structuredOutput?: unknown;
  aborted: boolean;
  error: string | null;
}

export interface ConversationQueuedUserInput {
  content: MessageContentBlock[];
  signal?: AbortSignal;
}

export interface ConversationBackendRuntime {
  readonly backend: AgentBackendId;
  readonly status: "alive" | "dead";
  readonly capabilities: ConversationBackendCapabilities;
  readonly modelId: string | undefined;
  readonly reasoningEffort: string | undefined;
  readonly outputFormat:
    | { type: "json_schema"; schema: Record<string, unknown> }
    | undefined;

  sendTurn(
    input: ConversationBackendTurnInput,
  ): Promise<ConversationBackendTurnResult>;
  queueUserInput?(input: ConversationQueuedUserInput): Promise<void>;
  applyPortableMcpConfig?(config: PortableMcpConfig): Promise<McpApplyResult>;
  close(): void;
}

export interface ConversationBackendCreateInput {
  conversationId: string;
  projectPath: string;
  projectName: string;
  sessionName: string;
  worktreePath: string;
  persistedRef: AgentSessionRef | null;
  modelId?: string;
  reasoningEffort?: string;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  sessionInstructions: string[];
  tooling: ConversationToolingOverrides;
  /**
   * Optional callback invoked by the backend runtime when SDK messages arrive
   * between caller-initiated turns — e.g. Claude Code's background-task
   * auto-continuation. Emits `external_turn_started`, `provider_event`s, and
   * `external_turn_completed` for each virtual turn.
   */
  onExternalTurnEvent?: (event: ConversationBackendEvent) => void;
}

export interface ConversationBackendFactory {
  readonly backend: AgentBackendId;
  createRuntime(
    input: ConversationBackendCreateInput,
  ): Promise<ConversationBackendRuntime>;
  validateModelAndEffort?(input: {
    modelId?: string;
    reasoningEffort?: string;
  }): void;
}
