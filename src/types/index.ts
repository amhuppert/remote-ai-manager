// ============================================================
// CC Data Entities (derived from Zod schemas)
// ============================================================

// Import MessageContentBlock locally for use in TranscriptMessage interface
import type { MessageContentBlock as _MessageContentBlock } from "@/lib/schemas";

export type {
  ClaudeModel,
  CodexConfig,
  CodexReasoningEffort,
  EffortLevel,
  GlobalConfig,
  PushNotificationConfig,
  PushTriggers,
  ValidatorType,
  WorkflowDefaults,
  WorkflowValidatorDefault,
  ConversationStatus,
  ConversationRole,
  DerivedSessionStatus,
  SessionState,
  ProjectState,
  ManagerState,
  PerRepoConfig,
  ConversationState,
  ForkedFrom,
  MessageContentBlock,
  ReferenceDocument,
} from "@/lib/schemas";

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
}

export type {
  RoadmapItemType,
  RoadmapItemStatus,
  RoadmapItem,
  CreateRoadmapItemRequest,
  UpdateRoadmapItemRequest,
  CreateSessionRequest,
  SessionCreationMode,
  CommitRequest,
  SessionArchiveRequest,
  RenameConversationRequest,
  CommitLogEntry,
  CommandType,
  CommandItem,
  CommandsResponse,
  FileItem,
  ProjectFilesResponse,
  ConversationStatusEvent,
  SSEEvent,
  AskQuestionOption,
  AskQuestionItem,
  AskQuestionEvent,
  AnswerQuestionRequest,
  JobType,
  JobStatus,
  JobStatusEvent,
  JobDispatchResponse,
  SessionFinishedEvent,
  SmartMergeRequest,
  ConflictEntry,
  ConflictDecisionInput,
  ResolveConflictsRequest,
  // Notification types
  NotificationType,
  Notification,
  NotificationCreatedEvent,
  NotificationUpdatedEvent,
  MessageQueuedEvent,
  GetNotificationsQuery,
  NotificationsResponse,
  MarkReadRequest,
  // Graph Workflow types
  GraphWorkflowAgentConfig,
  GraphWorkflowMutabilityPolicy,
  GraphWorkflowCircuitBreakerCondition,
  GraphWorkflowCircuitBreakerPolicy,
  GraphWorkflowIterationPolicy,
  GraphWorkflowAgentValidatorConfig,
  GraphWorkflowClaudeValidatorConfig,
  GraphWorkflowCodexValidatorConfig,
  GraphWorkflowScriptValidatorConfig,
  GraphWorkflowValidationFailurePolicy,
  GraphWorkflowTaskValidation,
  GraphWorkflowContextValidation,
  GraphWorkflowExecutionContextDefinition,
  GraphWorkflowTaskSource,
  GraphWorkflowTaskDefinition,
  GraphWorkflowContextEdge,
  WorkflowSemanticDefinition,
  GraphWorkflowPosition,
  GraphWorkflowViewport,
  GraphWorkflowVisualLayout,
  WorkflowDefinitionRecord,
  WorkflowValidatorIssue,
  WorkflowAgentValidatorResult,
  GraphWorkflowSharedDocumentEntry,
  GraphWorkflowStatus,
  GraphWorkflowContextStatus,
  GraphWorkflowTaskStatus,
  GraphWorkflowHaltReason,
  GraphWorkflowExecutionContextState,
  GraphWorkflowTaskState,
  GraphWorkflowRetryState,
  GraphWorkflowValidatorType,
  GraphWorkflowSSEEvent,
  GraphWorkflowExecutionEvent,
  GraphWorkflowExecution,
  WorkflowRuntimeEditOperation,
  WorkflowRuntimeEditRequest,
  WorkflowGraphValidationError,
  WorkflowPlanReference,
  WorkflowPlanRequest,
  WorkflowGeneratedDraft,
  GraphWorkflowStatusEvent,
  GraphWorkflowContextStatusEvent,
  GraphWorkflowTaskStatusEvent,
  GraphWorkflowValidationResultEvent,
  GraphWorkflowRetryEvent,
  GraphWorkflowCircuitBreakerEvent,
  GraphWorkflowSharedDocumentsUpdatedEvent,
  // Dev Server types
  DevServerConfig,
  DevServerStatus,
  DevServerStatusEvent,
  DevServerRuntimeState,
  DevServersStatusResponse,
  // Debug Mode types
  DebugHypothesis,
  DebugModePhase,
  DebugModeState,
  DebugLogEntry,
  DebugProbeEntry,
  DebugInstrumentationManifest,
  DebugModeStatusEvent,
  DebugLogReceivedEvent,
  DebugModeRequest,
  DebugRecordingRequest,
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

export type { RunPromptRequest, ImagePayload } from "@/lib/schemas";

/** Layout mode for the session detail view */
export type LayoutMode = "conversation" | "default" | "split" | "diff";

/** Background job state */
export interface BackgroundJob {
  jobId: string;
  jobType: "commit" | "merge" | "resolve-conflicts";
  status: "running" | "completed" | "failed" | "conflicts";
  projectName: string;
  sessionName: string;
  branchName: string;
  targetBranch?: string;
  startedAt: string;
  completedAt?: string;
  mergeHash?: string;
  commitHash?: string;
  conflictCount?: number;
  conflictFiles?: string[];
  errorMessage?: string;
  phase?: string;
}

/** Conflict analysis result stored in memory */
export interface ConflictAnalysis {
  jobId: string;
  projectName: string;
  sessionName: string;
  conflicts: import("@/lib/schemas").ConflictEntry[];
  resolvedAt?: string;
}

/** Tree of available .kiro/ markdown files */
export interface KiroDocTree {
  steering: string[];
  specs: Record<string, string[]>;
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
