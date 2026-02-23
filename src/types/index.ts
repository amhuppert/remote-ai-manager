// ============================================================
// CSM Data Entities (derived from Zod schemas)
// ============================================================

// Import MessageContentBlock locally for use in TranscriptMessage interface
import type { MessageContentBlock as _MessageContentBlock } from "@/lib/schemas";

export type {
  ClaudeModel,
  GlobalConfig,
  ConversationStatus,
  DerivedSessionStatus,
  SessionState,
  ProjectState,
  ManagerState,
  PerRepoConfig,
  ConversationState,
  MessageContentBlock,
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
  CreateSessionRequest,
  CommitRequest,
  MergeRequest,
  SessionArchiveRequest,
  RenameConversationRequest,
  CommitLogEntry,
  CommandType,
  CommandItem,
  CommandsResponse,
  ConversationStatusEvent,
  SSEEvent,
  AskQuestionOption,
  AskQuestionItem,
  AskQuestionEvent,
  AnswerQuestionRequest,
} from "@/lib/schemas";

/** Parsed transcript message */
export interface TranscriptMessage {
  /** Message role */
  role: "user" | "assistant";
  /** Message content blocks (text, tool_use, tool_result) */
  content: _MessageContentBlock[];
  /** ISO 8601 timestamp if available */
  timestamp: string | null;
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

/** Generic API error response */
export interface ApiError {
  /** Error message */
  error: string;
  /** Optional error code for programmatic handling */
  code?: string;
  /** Raw terminal output (stderr/stdout) from a failed git command */
  output?: string;
}
