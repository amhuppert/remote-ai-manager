// ============================================================
// CSM Data Entities
// ============================================================

/** Global application configuration stored in OS config directory */
export interface GlobalConfig {
  /** Path to directory containing git repositories to manage */
  baseDir: string;
  /** Glob patterns for directories to skip during project discovery */
  ignorePatterns: string[];
  /** Path to the manager state JSON file */
  stateFilePath: string;
  /** Timeout in ms for Claude CLI invocations (default: 300000) */
  claudeTimeoutMs: number;
}

/** Session status lifecycle */
export type SessionStatus = "idle" | "ready" | "running";

/** State for a single coding session within a project */
export interface SessionState {
  /** Human-readable session name (unique within project) */
  sessionName: string;
  /** Absolute path to the git worktree for this session */
  worktreePath: string;
  /** Git branch name (e.g., csm/feature-auth) */
  branchName: string;
  /** Claude CLI session ID (populated after first prompt via hooks) */
  claudeSessionId: string | null;
  /** Path to Claude transcript file (populated via hooks) */
  transcriptPath: string | null;
  /** Current session status */
  status: SessionStatus;
  /** ISO 8601 timestamp of session creation */
  createdAt: string;
  /** ISO 8601 timestamp of last activity */
  lastActivityAt: string;
  /** Total number of prompts sent to this session */
  promptCount: number;
  /** Whether the session has been archived */
  archived: boolean;
}

/** State for a single discovered project */
export interface ProjectState {
  /** Absolute path to the repository root */
  rootPath: string;
  /** Map of sessionName → SessionState */
  sessions: Record<string, SessionState>;
}

/** Top-level manager state persisted to disk */
export interface ManagerState {
  /** Map of projectPath → ProjectState */
  projects: Record<string, ProjectState>;
}

/** Per-repository configuration (ClaudeSessionManager.json at repo root) */
export interface PerRepoConfig {
  /** Path to init script (relative to repo root or absolute), null if none */
  initScriptPath: string | null;
}

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

/** Request body for creating a new session */
export interface CreateSessionRequest {
  /** Desired session name */
  sessionName: string;
}

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

/** Prompt execution request */
export interface RunPromptRequest {
  /** The prompt text to send to Claude */
  prompt: string;
}

/** Prompt execution response */
export interface RunPromptResponse {
  /** Whether execution succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/** Generic API error response */
export interface ApiError {
  /** Error message */
  error: string;
  /** Optional error code for programmatic handling */
  code?: string;
}
