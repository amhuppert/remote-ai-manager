# Remote Claude Code Session Manager Implementation Plan

## 0. Final Requirements Recap (constraints that drive implementation)

- **Projects** are discovered by scanning **one configured base directory** **one level deep** for git repos (ignore common dirs).
- **Sessions**:
  - Identified by **manager-only session name** (unique per project; reject duplicates).
  - Each session has its **own git worktree** based on **`main`** branch head.
  - Manager creates a **new branch derived from the session name** for that worktree.
  - **No transcript copying / no session continuity** when creating sessions (each session starts fresh).
  - On worktree creation, run an optional **project-specific init script** configured in a **repo-root config file**; if it fails, session creation fails.
  - Sessions are **resumable** (not a long-running terminal), with **one CLI invocation per prompt**.
  - **Single-flight** per session: at most one in-progress prompt run at a time.
- **Claude Code integration**:
  - Use **Claude Code transcripts** (JSONL) for conversation history and final response.
  - Do **not** capture terminal output.
  - **Hooks are required** and configured globally; hooks give `session_id`, `transcript_path`, `cwd`, etc. [Claude Code+1](https://code.claude.com/docs/en/hooks)
  - Manager stores **Claude session ID** internally (but session selection is by session name).
- **Diffs**:
  - Show git diff of worktree vs `main` (no incremental diffs for now).
- **Remote access**:
  - Web UI hosted on same machine and exposed **tailnet-only** using **Tailscale Serve**; no extra auth. [Tailscale+1](https://tailscale.com/blog/tailscale-funnel-beta)
- **Persistence**:
  - Sessions persist across reboots via manager state file + on-disk worktrees.
  - Deleting/archiving a session removes manager metadata + removes the worktree, but:
    - Leave the session’s **branch** behind.
    - Leave Claude transcripts untouched.

## 1. Repo + Runtime Setup

### 1.1 Create the Next.js app (Bun + TS)

- Create the project:
  - `bun create next-app claude-session-manager --typescript`
- Ensure you’re using the Node runtime for route handlers (not edge), since you’ll spawn local processes and read files.

### 1.2 Add required packages (explicit)

Install:

- `zod` (runtime schema validation)
- `env-paths` (cross-platform config/data dirs)
- `proper-lockfile` (safe concurrent reads/writes to JSON state/config)
- `nanoid` (IDs for runs/sessions if needed)
- Optional UI:
  - `@radix-ui/react-*` or just keep minimal with basic components

Command:

- `bun add zod env-paths proper-lockfile nanoid`

## 2. File Layout (no ambiguity)

Use this structure:

```
claude-session-manager/
  app/
    page.tsx                              # Projects list
    projects/[projectId]/page.tsx          # Project sessions list
    projects/[projectId]/sessions/[name]/page.tsx  # Session detail: prompt, history, diff
    api/
      config/route.ts                      # GET/PUT global config
      projects/route.ts                    # GET discovered projects
      projects/[projectId]/sessions/route.ts       # GET/POST sessions
      projects/[projectId]/sessions/[name]/route.ts # GET/DELETE session
      projects/[projectId]/sessions/[name]/prompt/route.ts # POST prompt -> run job
      runs/[runId]/route.ts                # GET run status + final response
  src/
    core/
      paths.ts                             # env-paths wrapper
      lock.ts                              # proper-lockfile helpers
      config.ts                            # global config load/save + zod schema
      state.ts                             # manager state load/save + zod schema
      discovery.ts                         # baseDir scan for repos
      sessions.ts                          # create/delete/list sessions
      worktrees.ts                         # git worktree + branch creation/removal
      initScript.ts                        # per-project init script runner
      claude.ts                            # spawn Claude Code CLI
      hooks.ts                             # hook event ingestion + state update
      transcripts.ts                       # parse JSONL into messages + last assistant text
      diffs.ts                             # git diff + status
      runs.ts                              # run lifecycle + single-flight
    bin/
      csm.ts                               # bun executable entry (hooks installer + hook handler)
```

## 3. Data Models (exact schemas)

### 3.1 Global config (config directory JSON)

Store in OS config dir (Linux: `~/.config/...`) using `env-paths`:

- file: `<configDir>/config.json`

Schema (Zod + persisted JSON):

```ts
GlobalConfig = {
  version: "0.1",
  baseDir: string,                 // directory to scan, one level deep
  ignoreDirNames: string[],        // default list (see below)
  worktreesDir: string,            // where worktrees live (default: envPaths.data + "/worktrees")
  web: { port: 3000 },
}
```

**Default `ignoreDirNames`** (use this exact set):

- `.git`, `.hg`, `.svn`, `.DS_Store`, `.idea`, `.vscode`
- `node_modules`, `.next`, `dist`, `build`, `out`, `.cache`, `.turbo`
- `.pnpm-store`, `.yarn`, `.bun`, `coverage`, `tmp`, `temp`

(You can tweak later, but ship these as the default.)

### 3.2 Per-project config (repo root file)

File name (repo root):

- `ClaudeSessionManager.json`

Schema:

```ts
ProjectConfig = {
  version: "0.1",
  initScript?: string // path to executable script (relative to repo root allowed)
}
```

Rules:

- If file missing: treat as `{}` (no init script).
- If `initScript` exists:
  - Resolve to absolute path based on repo root if relative.
  - Must be executable (or run via shell explicitly).
  - Must run with `cwd = worktreePath`.
  - If it fails (non-zero exit): **session creation fails** and must rollback worktree+branch.

### 3.3 Manager state (data directory JSON)

Store in OS data dir using `env-paths`:

- file: `<dataDir>/state.json`

Schema:

```ts
State = {
  version: "0.1",
  projects: {
    [projectId: string]: {
      id: string,
      name: string,          // folder name (display)
      repoRoot: string,      // absolute path
      createdAt: string
    }
  },
  sessions: {
    [sessionKey: string]: {
      projectId: string,
      name: string,          // unique per project
      branchName: string,
      worktreePath: string,  // absolute
      claudeSessionId?: string,
      transcriptPath?: string,
      createdAt: string,
      updatedAt: string,
      inFlightRunId?: string // for single-flight enforcement
    }
  }
}
```

**Keys**

- `projectId`: stable hash of `repoRoot` (e.g., sha1(repoRoot) or a sanitized base64url). Choose sha1 for simplicity.
- `sessionKey`: `${projectId}:${sessionName}` (string).

## 4. Git + Worktree Behavior (exact commands)

### 4.1 Branch name derivation (deterministic)

From session name:

1. Lowercase
2. Replace spaces with `-`
3. Remove anything not `[a-z0-9._/-]` (replace with `-`)
4. Collapse multiple `-`
5. Prefix with `csm/`

Example:

- session name `"Fix Login Bug"` → branch `"csm/fix-login-bug"`

### 4.2 Create a session (worktree + branch)

Preconditions:

- Repo exists and is a git repo.
- `main` exists locally in that repo (if not, fail with explicit error).

Commands (run in repo root):

1. Ensure clean enough to create worktree (no strict requirement; just proceed).
2. Create worktree directory:
    - `worktreePath = <worktreesDir>/<projectId>/<sessionNameSlug>`
3. Create worktree + branch from main head:
    - `git worktree add -b <branchName> <worktreePath> main`

### 4.3 Init script

If `ClaudeSessionManager.json` has `initScript`:

- Run it as a process:
  - `cwd = worktreePath`
  - `env` includes:
    - `CSM_REPO_ROOT=<repoRoot>`
    - `CSM_WORKTREE_PATH=<worktreePath>`
    - `CSM_SESSION_NAME=<sessionName>`
    - `CSM_BRANCH_NAME=<branchName>`
- If exit code != 0:
  - Roll back:
    - `git worktree remove --force <worktreePath>`
    - `git branch -D <branchName>` (since creation failed; branch should not be left behind in a failed create)

### 4.4 Delete/archive session

Behavior is the same (two UI buttons, same backend):

- Remove manager metadata for the session.
- Remove the worktree:
  - `git worktree remove --force <worktreePath>`
- **Do not delete** the branch (leave it behind).
- **Do not delete** Claude transcripts.

## 5. Claude Code Invocation Strategy (no terminal persistence)

### 5.1 How prompts run

Use one process invocation per prompt, working directory = session worktree.

- First prompt (new session):
  - `claude -p "<prompt>"`
- Subsequent prompts:
  - `claude -c -p "<prompt>"` (continue most recent conversation in that worktree; per CLI reference) [Claude Code](https://code.claude.com/docs/en/cli-reference?utm_source=chatgpt.com)

This avoids requiring `--resume <session_id>` and relies on “one worktree per session” to make `--continue` unambiguous.

### 5.2 Why hooks are required

Hooks provide:

- `session_id`, `transcript_path`, `cwd` for every event [Claude Code](https://code.claude.com/docs/en/hooks)
- `Stop` always fires when Claude finishes responding [Claude Code](https://code.claude.com/docs/en/hooks)  
  Manager uses this to:
- Bind a manager session (via worktree `cwd`) to a Claude session ID and transcript file.
- Know where to read transcripts for history/final answer.


## 6. Hook Handler Implementation (core of “transcripts-first”)


### 6.1 Global hook configuration location

Claude Code user settings live at:

- `~/.claude/settings.json` [Claude Code+1](https://code.claude.com/docs/en/settings)

Hooks are defined in settings JSON and receive JSON on stdin. [Claude Code+1](https://code.claude.com/docs/en/hooks)

### 6.2 What hooks to install (exact)

Install two hooks globally:

- `UserPromptSubmit` (captures session id/path early)
- `Stop` (captures transcript path after completion)

Note: `UserPromptSubmit` and `Stop` ignore matchers and always fire. [Claude Code+1](https://code.claude.com/docs/en/hooks)

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [{ "type": "command", "command": "/ABS/PATH/TO/csm hook" }]
      }
    ],
    "Stop": [
      {
        "hooks": [{ "type": "command", "command": "/ABS/PATH/TO/csm hook" }]
      }
    ]
  }
}
```

Implementation notes:

- Use an **absolute path** to avoid cwd issues.
- Your `csm hook` reads stdin JSON and updates manager state.

### 6.3 `csm hook` behavior (deterministic)

Input: JSON from stdin with common fields: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, etc. [Claude Code](https://code.claude.com/docs/en/hooks)

Algorithm:

1. Parse stdin JSON.
2. If `cwd` is missing: exit 0.
3. Load manager state (with file lock).
4. Find the session whose `worktreePath === cwd` (exact match).
    - If none: exit 0 (this Claude run isn’t managed).
5. Update session record:
    - `claudeSessionId = input.session_id`
    - `transcriptPath = input.transcript_path`
    - `updatedAt = now`
6. Save state atomically.
7. Exit 0.

### 6.4 Hooks take effect timing

Claude Code snapshots hooks at startup; changes may require review in `/hooks` and won’t apply mid-session. [Claude Code+1](https://code.claude.com/docs/en/hooks)  
So implement a “Doctor” check in your UI/CLI that:

- Confirms `~/.claude/settings.json` contains your hook commands
- Prints instructions: restart Claude Code sessions if needed

## 7. Transcript Parsing (for history + final answer)

Transcripts are JSONL where each line is a JSON event; assistant/user messages appear with `type` `"assistant"` / `"user"` and a nested `message` object with role/content. [Liam ERD](https://liambx.com/blog/claude-code-log-analysis-with-duckdb)

### 7.1 Parser behavior

Given `transcriptPath`:

1. Read file as text.
2. Split by lines, parse each JSON object.
3. Convert into a normalized list:

```ts
NormalizedMessage = {
  ts: string,
  role: "user" | "assistant",
  text: string,
};
```

Extraction rules:

- If `obj.message?.content` is string → use it.
- If it’s an array of blocks → join all blocks where `block.type === "text"` using `block.text`.
- Ignore tool events, permission events, etc. (anything without a user/assistant role).

### 7.2 “Final response only”

To satisfy “show only final response once complete”:

- When a prompt run finishes, read transcript and return **only the last assistant message** in the file as `finalText`.

## 8. Run Lifecycle + Single-Flight Enforcement

### 8.1 Run model

Maintain an in-memory `runs` map in the server process plus minimal persisted markers in session state.

- In-memory:

```ts
Run = {
  id: string,
  sessionKey: string,
  status: "running" | "succeeded" | "failed",
  startedAt: string,
  finishedAt?: string,
  error?: string,
  finalText?: string
}
```

- Persisted in session record:
  - `inFlightRunId` set when run starts, cleared when it ends.

### 8.2 Starting a run (server-side)

On `POST /prompt`:

1. Load state with lock.
2. Check session exists.
3. If `inFlightRunId` is set → reject with 409 “session busy”.
4. Create `runId`; set `inFlightRunId = runId`; save state.
5. Spawn Claude Code process (`claude -p` or `claude -c -p`) in worktree.
6. Wait for process exit.
7. On exit:
    - If exit != 0: mark run failed, clear `inFlightRunId`.
    - If exit == 0:
      - Prefer reading transcriptPath recorded by hook.
      - If transcriptPath still missing, poll briefly (e.g., up to 2s, 10×200ms) by reloading state until it appears (since hooks may update slightly after process exit).
      - Parse transcript; set `finalText` to last assistant message; mark run succeeded.
    - Clear `inFlightRunId` in state and save.

### 8.3 Server restart behavior

At server startup:

- Load state and clear all `inFlightRunId` values (treat them as stale), since you cannot recover the process safely.

## 9. Next.js API Routes (exact contract)

### 9.1 Config

- `GET /api/config` → returns GlobalConfig
- `PUT /api/config` → validate with Zod, save

### 9.2 Projects (discovery)

- `GET /api/projects`
  - Loads config.baseDir
  - Scans one level deep
  - Returns discovered list (projectId + name + repoRoot)
  - Also ensures state.projects is populated for discovered repos

### 9.3 Sessions

- `GET /api/projects/:projectId/sessions`
  - Returns sessions for project from state
- `POST /api/projects/:projectId/sessions`
  - body: `{ name: string }`
  - Enforce unique per project; reject duplicates
  - Create worktree+branch
  - Run optional init script
  - Write session record to state
  - Return session detail
- `GET /api/projects/:projectId/sessions/:name`
  - Returns session detail + derived “health”:
    - worktree exists?
    - transcriptPath known?
- `DELETE /api/projects/:projectId/sessions/:name`
  - Removes worktree + deletes session record
  - Leaves branch + transcripts

### 9.4 Prompt runs

- `POST /api/projects/:projectId/sessions/:name/prompt`
  - body: `{ prompt: string }`
  - Starts run; returns `{ runId }`
- `GET /api/runs/:runId`
  - Returns `{ status, finalText?, error? }`

### 9.5 Session detail helpers

- `GET /api/projects/:projectId/sessions/:name/history`
  - Parse transcript into normalized messages, return last N messages (e.g., 200)
- `GET /api/projects/:projectId/sessions/:name/diff`
  - Returns:
    - `gitStatus` (porcelain)
    - `diffText` from `git diff main...` (includes uncommitted vs merge-base)  
      (Run in `worktreePath`)

## 10. Web UI Pages (minimal but complete)

### 10.1 `/` Projects page

- Shows discovered projects from `/api/projects`
- Each links to `/projects/:projectId`

### 10.2 `/projects/:projectId` Sessions list

- List existing sessions
- Create session form:
  - session name input
  - submit → POST sessions
- Each session links to `/projects/:projectId/sessions/:name`

### 10.3 Session detail page

Sections:

1. **Prompt box**
    - Textarea + “Run”
    - On submit: POST `/prompt` → get runId
    - Poll `/runs/:runId` every 500ms until done
    - Display **finalText only**
2. **Conversation history**
    - Fetch `/history` on load + refresh button
3. **Git diff**
    - Fetch `/diff` on load + refresh button
4. **Delete / Archive**
    - Button calls DELETE session

## 11. Project Discovery (one-level scan)

In `src/core/discovery.ts`:

Algorithm:

1. Read `baseDir`.
2. List children (directories only).
3. Skip if name in `ignoreDirNames`.
4. Detect git repo:
    - if `<child>/.git` exists (dir or file) → repo root
5. Return list.

Persist:

- For each discovered repo, create `projectId` and store in `state.projects` if missing.

## 12. Tailscale Serve (tailnet-only exposure)

### 12.1 Recommended command (simple)

With Next.js running on port 3000:

- `tailscale serve https / http://localhost:3000` [Tailscale](https://tailscale.com/blog/tailscale-funnel-beta)

This exposes it to your tailnet over HTTPS on the device’s `*.ts.net` name (tailnet-only unless you enable Funnel).

### 12.2 Optional: services config file (repeatable)

Use a services config file (huJSON) per Tailscale docs: [Tailscale](https://tailscale.com/kb/1589/tailscale-services-configuration-file)

Example `csm-tailscale.json`:

```json
{
  "version": "0.0.1",
  "services": {
    "svc:claude-session-manager": {
      "endpoints": {
        "tcp:443": "http://localhost:3000"
      }
    }
  }
}
```

Apply:

- `tailscale serve -config ./csm-tailscale.json`

(Use whichever approach you prefer; the command approach is fastest.)

## 13. "Install Hooks" CLI (hard requirement enforcement)

Implement `src/bin/csm.ts` with subcommands:

- `csm install-hooks`
  - Locates `~/.claude/settings.json` (per docs) [Claude Code+1](https://code.claude.com/docs/en/settings)
  - Reads JSON (create file if missing)
  - Merges in required hooks (UserPromptSubmit, Stop)
  - Writes back atomically
  - Prints reminder:
    - Hooks may require restarting sessions / review in `/hooks` [Claude Code](https://code.claude.com/docs/en/hooks)
- `csm hook`
  - Hook handler described above

Your Next.js UI can also show a banner “Hooks not installed” based on a server-side check:

- Does `~/.claude/settings.json` contain your hook command entries?

## 14. Testing Plan (so implementation is safe)

### 14.1 Unit tests (pure logic)

- Branch name derivation from session name
- Config/state Zod validation
- Repo discovery ignoring logic
- Transcript parsing:
  - Use fixture JSONL lines matching the known structure [Liam ERD](https://liambx.com/blog/claude-code-log-analysis-with-duckdb)

### 14.2 Integration tests (temp dirs)

Use a temp directory and real git:

1. Initialize a repo with `main`.
2. Create session:
    - Verify worktree exists, branch exists, state updated.
3. Init script failure path:
    - Provide script that exits 1
    - Verify worktree removed and branch deleted
4. Delete session:
    - Verify worktree removed, branch remains

(You can run these as Node/Bun tests that spawn `git`.)

## 15. Deployment (no decisions left)

- Build:
  - `bun run build`
- Start:
  - `bun run start -- --port 3000`
- Expose to tailnet:
  - `tailscale serve https / http://localhost:3000` [Tailscale](https://tailscale.com/blog/tailscale-funnel-beta)
- One-time setup:
  - `bunx csm install-hooks`
  - Confirm in Claude Code `/hooks` that they’re active (if required by snapshotting behavior). [Claude Code](https://code.claude.com/docs/en/hooks)


If you want, next I can convert this directly into:

- a step-by-step task checklist (tickets),
- the exact Zod schemas + TS types,
- and the exact route handler signatures (request/response types) and error codes—so coding becomes mostly transcription.
