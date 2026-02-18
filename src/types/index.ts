// ============================================================
// CSM Data Entities (derived from Zod schemas)
// ============================================================

export type {
  GlobalConfig,
  SessionStatus,
  SessionState,
  ProjectState,
  ManagerState,
  PerRepoConfig,
  ConversationMessage,
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
  CommitLogEntry,
  CommandType,
  CommandItem,
  CommandsResponse,
} from "@/lib/schemas";

/** Parsed transcript message */
export interface TranscriptMessage {
  /** Message role */
  role: "user" | "assistant";
  /** Message content (may contain markdown) */
  content: string;
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

export type { RunPromptRequest } from "@/lib/schemas";

/** Layout mode for the session detail view */
export type LayoutMode = "conversation" | "default" | "split" | "diff";

/** Prompt execution response */
export interface RunPromptResponse {
  /** Whether execution succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Claude's response text (extracted from CLI JSON output) */
  claudeResponse?: string;
}

/** Generic API error response */
export interface ApiError {
  /** Error message */
  error: string;
  /** Optional error code for programmatic handling */
  code?: string;
}
