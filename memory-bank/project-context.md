# Claude Session Manager — Project Report

## 1) Project overview

A local-first system that lets a single developer manage **Claude Code** coding sessions across multiple git projects **remotely** via a web UI. It:

- discovers projects under a configurable base directory
- creates isolated per-session **git worktrees** (one session = one worktree + branch)
- runs prompts by executing the Claude CLI (one invocation per request)
- displays conversation history by reading Claude transcript files
- shows code changes using git diffs vs `main`
- is reachable securely over the user’s tailnet via Tailscale Serve (no extra app auth)

## 2) Purpose

Enable fast, low-friction remote control of Claude Code sessions (start sessions, send prompts, review outputs, inspect diffs) without requiring a terminal remoting experience, and without mixing concurrent work across projects or sessions.

## 3) Goals (what success looks like)

- **Reliable project discovery**: shows correct list of repos under the base directory (1-level scan).
- **Safe isolation**: each session runs in its own worktree and branch derived from the session name.
- **Resumable sessions**: after reboot/service restart, sessions still exist and can be continued (not “always running”).
- **Simple remote interaction**: user can send a prompt to a chosen session and see the final response.
- **Trustworthy history**: conversation history renders from Claude transcripts (no terminal scraping).
- **Actionable code visibility**: user can view diffs vs `main` for each session worktree.
- **Tailnet-only access**: web UI not exposed publicly by default.

## 4) Design decisions

### 4.1 Two-component architecture (local service + web UI)

- **Local service**: owns filesystem/git operations, session state, Claude CLI invocation, transcript reading.
- **Web interface**: Next.js UI + server endpoints calling the local service on the same machine.
- Deployment is single-host: UI is served locally and published to the tailnet via Tailscale Serve.

### 4.2 Session model

- **Session identity (UI-level)**: `(project, sessionName)` where `sessionName` is **unique per project**.
- **Claude identity (internal)**: store the **Claude session ID** in manager state and use it to resume/continue.
- Sessions start **fresh** (no continuity/copying of session data when creating worktrees).

### 4.3 Git isolation via worktrees

- Base branch is always **`main`**.
- Creating a session:
  - creates a worktree
  - creates a new branch **derived from sessionName** (sanitized)
- Deleting/archiving a session deletes the **worktree directory** and manager metadata, but:
  - **does not delete the branch**
  - **does not delete transcripts**

### 4.4 Prompt execution

- One prompt = one Claude CLI invocation in the session’s worktree directory.
- **Single-flight per session**: at most one in-flight invocation at a time per session (reject or queue; MVP can reject with “busy”).
- UI displays **final response only** after the invocation completes.

### 4.5 Transcript-driven history (no terminal capture)

- The system reads conversation history from **Claude transcript files**.
- Claude hooks are a **hard requirement** to reliably capture session metadata (at minimum: `session_id`, `transcript_path`, `cwd`) for each run/session.

### 4.6 Hooks requirement (global)

- Hooks are configured **globally** once for the user’s Claude Code installation (from Anthropic).
- Hooks are used to:
  - populate/refresh the manager’s mapping of `(project, sessionName)` → `claudeSessionId` (+ transcript path)
  - support robust transcript discovery without hardcoding Claude’s storage paths

### 4.7 Worktree initialization is project-configurable

- Each repo may include `ClaudeSessionManager.json` at repo root.
- Config points to a **path to an executable init script**.
- On session creation, the init script runs with env vars:
  - `PROJECT_ROOT`, `WORKTREE_PATH`, `SESSION_NAME`, `BRANCH_NAME`
- If config is missing, init is a **no-op**.
- If init script is configured but fails, **session creation fails** (and should not leave partially-created state).

### 4.8 Project discovery

- Scan **one directory level** under a configured base directory.
- Identify repos by presence of a `.git` directory/file.
- Ignore common heavy/noisy directories by default (e.g., `node_modules`, `.next`, `dist`, `build`, `target`, `.cache`, `.turbo`, `.venv`, etc.).

### 4.9 Remote access and security

- Web UI is hosted on the same machine as the local service.
- Published over the tailnet via Tailscale Serve.
- **No app-level authentication** (tailnet membership is the access control boundary).

## 5) Relevant context for an AI coding agent

### 5.1 Assumptions & prerequisites

- Claude Code CLI installed and functional on the host.
- Git installed; repositories use `main` as the baseline branch.
- Tailscale installed and configured on host and remote devices (tailnet membership required).
- Ability to configure global Claude hooks (one-time setup).

### 5.2 Persistent data and config

#### Global config (JSON, in OS config directory)

- Stores:
  - base directory to scan
  - ignore list (optional override/extend)
  - manager state file path
  - any operational toggles (timeouts, concurrency behavior)

#### Manager state (JSON, also in config directory)

- Stores per project:
  - project root path
  - sessions:
    - `sessionName`
    - `worktreePath`
    - `branchName`
    - `claudeSessionId` (once known)
    - `transcriptPath` (optional but strongly useful)
    - status metadata (archived flag, last activity timestamps)

#### Per-repo config (`ClaudeSessionManager.json`)

- Stores:
  - `initScriptPath` (relative to repo root or absolute)

### 5.3 Core flows

#### Project discovery

1. Read global config → baseDir + ignore list
2. Scan one level for git repos → build project index

#### Create session

1. Validate unique `sessionName` within project (reject on collision)
2. Create worktree from `main`
3. Create new branch derived from `sessionName`
4. If repo has `ClaudeSessionManager.json` with init script:
   - run script with env vars
   - on failure: roll back worktree creation + state
5. Record session in manager state (without Claude session ID initially)

#### Run prompt

1. Enforce single-flight lock for `(project, sessionName)`
2. Execute Claude CLI in `cwd = worktreePath`
3. Hooks capture `session_id`/`transcript_path` and manager records/updates mapping
4. After completion, read transcript file and return the final response to UI

#### Archive/delete session

- Remove session metadata from manager state
- Delete worktree directory
- Leave branch + transcripts untouched

### 5.4 Web UI expectations

- Pages/views:
  - Projects list
  - Project detail: sessions list (active/archived)
  - Session detail: prompt box + final response, transcript viewer, git diff viewer vs `main`
- Actions:
  - create session
  - run prompt
  - archive/delete session

### 5.5 Non-goals (explicit)

- No terminal remoting UX.
- No session continuity/copying when creating worktrees.
- No automatic committing/merging; user handles git commits manually.
- No incremental per-turn diffs (deferred).
