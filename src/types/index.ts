// ============================================================
// CC Data Entities (derived from Zod schemas)
// ============================================================

// Import MessageContentBlock locally for use in TranscriptMessage interface
import type { MessageContentBlock as _MessageContentBlock } from "@/lib/schemas";

export type {
  ClaudeModel,
  CodexConfig,
  CodexModel,
  CodexReasoningEffort,
  EffortLevel,
  GlobalConfig,
  PushNotificationConfig,
  WorkflowDefaults,
  ConversationStatus,
  ConversationRole,
  DerivedSessionStatus,
  SessionState,
  SessionListItem,
  ProjectState,
  ProjectRow,
  ManagerState,
  PerRepoConfig,
  ConversationState,
  ForkedFrom,
  MessageContentBlock,
  ToolResultMetrics,
  ReferenceDocument,
  AgentBackendId,
  AgentSessionRef,
  ImageMediaType,
  ImagePayload,
} from "@/lib/schemas";

export type {
  ConversationBackendRuntime,
  ConversationBackendFactory,
  ConversationBackendTurnInput,
  ConversationBackendTurnResult,
  ConversationBackendEvent,
  ConversationImageRef,
} from "@/lib/agent-backends/conversation";

export type { ConversationToolingOverrides } from "@/lib/agent-backends/types";

export type {
  AgentTaskRunner,
  AgentTaskRequest,
  AgentTaskResult,
} from "@/lib/agent-backends/task";

export type {
  PortableMcpConfig,
  McpApplyResult,
} from "@/lib/agent-backends/portable-mcp";

// ============================================================
// API Types
// ============================================================

/** Discovered project info returned by the discovery API */
export interface DiscoveredProject {
  /** Repository name (directory name) */
  name: string;
  /** Absolute path to the repository root */
  path: string;
  /** Number of active (non-archived) sessions */
  activeSessions: number;
  /** Whether any session is currently running */
  hasRunningSession: boolean;
  /** True when the project exists in state but the directory is no longer present on disk */
  missing?: boolean;
}

export type {
  SessionCreationMode,
  CommitLogEntry,
  CommandItem,
  CommandsResponse,
  FileItem,
  ConversationStatusEvent,
  SSEEvent,
  ScopedStatusEvent,
  AskQuestionItem,
  AskQuestionEvent,
  JobType,
  JobStatus,
  JobStatusEvent,
  BackgroundJob,

  // Notification types
  NotificationType,
  Notification,

  // Graph Workflow types
  GraphWorkflowLaneKind,
  GraphWorkflowExecutionSessionRef,
  GraphWorkflowValidationReviewArtifact,
  GraphWorkflowAgentSessionTurnUsage,
  GraphWorkflowAgentSessionState,
  GraphWorkflowAgentConfig,
  GraphWorkflowMutabilityPolicy,
  GraphWorkflowCircuitBreakerPolicy,
  GraphWorkflowIterationPolicy,
  GraphWorkflowAgentValidatorConfig,
  GraphWorkflowScriptValidatorConfig,
  ContextValidatorOverride,
  WorkflowConfigOverride,
  GraphWorkflowResolvedContext,
  ResolvedWorkflowSemanticDefinition,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowTaskDefinition,
  GraphWorkflowContextEdge,
  WorkflowSemanticDefinition,
  GraphWorkflowVisualLayout,
  WorkflowDefinitionRecord,
  WorkflowValidatorIssue,
  GraphWorkflowSharedDocumentEntry,
  GraphWorkflowStatus,
  GraphWorkflowContextStatus,
  GraphWorkflowTaskStatus,
  GraphWorkflowHaltReason,
  GraphWorkflowExecutionContextState,
  GraphWorkflowExecutionLaneState,
  GraphWorkflowExecutionLaneCommitSnapshot,
  GraphWorkflowExecutionJoinKind,
  GraphWorkflowExecutionJoinStatus,
  GraphWorkflowExecutionJoinState,
  GraphWorkflowTaskState,
  GraphWorkflowValidatorType,
  GraphWorkflowSSEEvent,
  GraphWorkflowExecutionEvent,
  GraphWorkflowExecution,
  WorkflowRuntimeEditRequest,
  WorkflowGraphValidationError,
  WorkflowPlanRequest,
  WorkflowGeneratedDraft,
  GraphWorkflowStatusEvent,
  GraphWorkflowValidationResultEvent,
  GraphWorkflowCircuitBreakerEvent,
  GraphWorkflowSharedDocumentsUpdatedEvent,
  GraphWorkflowPendingHaltReasonEvent,
  GraphWorkflowMergeStatusEvent,
  GraphWorkflowBatchScheduledEvent,
  GraphWorkflowLaneStatusEvent,
  GraphWorkflowJoinStatusEvent,
  GraphWorkflowMergeStatusValue,
  GraphWorkflowCleanupStatusValue,
  // Dev Server types
  DevServerConfig,
  DevServerStatus,
  DevServerSource,
  DevServerStatusEvent,
  DevServerRuntimeState,
  DevServersStatusResponse,
  // Debug Mode types
  DebugHypothesis,
  DebugModePhase,
  DebugModeState,
  DebugLogEntry,
  DebugInstrumentationManifest,
  DebugModeStatusEvent,
  McpConfigUpdatedEvent,
  McpToolsUpdatedEvent,

  // MCP Configuration types
  McpInheritanceStatus,
  McpOverrides,
  McpToolView,
  McpToolListView,
  McpServerView,
  McpConfigViewResponse,
  McpToolInventoryResult,

  // Agent Capability Configuration types
  AgentCapabilityRuntimeApplicationState,
  AgentCapabilityViewRow,
  AgentCapabilityViewResponse,
} from "@/lib/schemas";

/** Parsed transcript message */
export interface TranscriptMessage {
  /** Message role */
  role: "user" | "assistant";
  /** Message content blocks (text, tool_use, tool_result) */
  content: _MessageContentBlock[];
  /** ISO 8601 timestamp if available */
  timestamp: string | null;
  /** Model used for this turn (e.g., "opus", "sonnet") */
  model?: string;
  /** Reasoning effort level used for this turn */
  effort?: string;
}

/** Parsed diff for a single file */
export interface FileDiff {
  /** File path relative to repo root */
  filePath: string;
  /** Number of added lines */
  additions: number;
  /** Number of deleted lines */
  deletions: number;
  /** Raw diff hunks */
  hunks: DiffHunk[];
}

/** A single diff hunk */
export interface DiffHunk {
  /** Hunk header (e.g., @@ -1,3 +1,5 @@) */
  header: string;
  /** Diff lines within this hunk */
  lines: DiffLine[];
}

/** A single line in a diff */
export interface DiffLine {
  /** Line type */
  type: "context" | "add" | "remove" | "hunk-header";
  /** Line content (without +/- prefix) */
  content: string;
}

/** Diff summary for a session */
export interface SessionDiff {
  /** Per-file diffs */
  files: FileDiff[];
  /** Total additions across all files */
  totalAdditions: number;
  /** Total deletions across all files */
  totalDeletions: number;
}

export type { RunPromptRequest } from "@/lib/schemas";

/** Layout mode for the session detail view */
export type LayoutMode = "conversation" | "default" | "split" | "diff";

/** Conflict analysis result stored in memory */
export interface ConflictAnalysis {
  jobId: string;
  projectName: string;
  sessionName: string;
  conflicts: import("@/lib/schemas").ConflictEntry[];
  resolvedAt?: string;
}

/** Generic API error response */
export interface ApiError {
  /** Error message */
  error: string;
  /** Optional error code for programmatic handling */
  code?: string;
  /** Raw terminal output (stderr/stdout) from a failed git command */
  output?: string;
}
