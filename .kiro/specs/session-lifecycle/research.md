# Research & Design Decisions

## Summary

- **Feature**: `session-lifecycle` (Conversation model extension)
- **Discovery Scope**: Extension (existing system)
- **Key Findings**:
  - Claude Code stores sessions as JSONL files in `~/.claude/projects/<encoded-path>/`, with an optional `sessions-index.json` for fast metadata lookup
  - The Claude CLI supports `--session-id <id>` to continue a specific session, replacing the `-c` flag which continues the most recent session in the cwd
  - Existing session state stores `claudeSessionId`, `transcriptPath`, `status`, `messages`, and `promptCount` directly — all must migrate to per-Conversation records

## Research Log

### Claude Code Session Storage Format

- **Context**: Auto-import requires understanding how Claude Code stores sessions on disk.
- **Sources Consulted**: `~/.claude/projects/` filesystem exploration, JSONL transcript file analysis
- **Findings**:
  - Projects stored by encoded path: `/home/user/project` → `-home-user-project`
  - Sessions are UUID-named JSONL files (e.g., `07990e45-d443-471c-846a-2fa162fbc6bf.jsonl`)
  - `sessions-index.json` (when present) contains: `sessionId`, `fullPath`, `firstPrompt`, `summary`, `messageCount`, `created`, `modified`, `gitBranch`, `projectPath`, `isSidechain`
  - Not all projects have `sessions-index.json` — only ~22% in the sample had it
  - JSONL entries contain `sessionId`, `cwd`, `gitBranch`, `message.role`, `message.content`, `timestamp`
- **Implications**: Auto-import must support both indexed and fallback (JSONL parsing) discovery. Filter by `cwd` or `gitBranch` to match worktree sessions.

### Claude CLI Session Continuation

- **Context**: Prompt execution needs to target a specific conversation, not just the most recent.
- **Sources Consulted**: Claude Code CLI `--help`, existing `prompt.ts` usage
- **Findings**:
  - Current code uses `-c` flag for continuation, which continues the most recent session in the cwd
  - Claude CLI supports `--session-id <uuid>` to target a specific session
  - First prompt (no session ID): `claude -p "<prompt>"` starts a new session
  - Subsequent prompts: `claude --session-id <uuid> -p "<prompt>"` continues the specific session
  - JSON output includes `session_id` in response
- **Implications**: Replace `-c` flag with `--session-id` for conversation-scoped execution. First prompt omits `--session-id` to create a new Claude Code session.

### State Migration Strategy

- **Context**: Existing sessions store conversation data directly; new model requires moving it to Conversation records.
- **Findings**:
  - Fields moving from SessionState to ConversationState: `claudeSessionId`, `transcriptPath`, `status`, `messages`, `promptCount`
  - Fields remaining on SessionState: `sessionName`, `worktreePath`, `branchName`, `createdAt`, `lastActivityAt`, `archived`, `finished`
  - New field on SessionState: `conversations` (array)
  - Backward compatibility: read-time migration wraps old session data into a single Conversation if `conversations` is absent
- **Implications**: No offline migration step needed. Schema uses `.default([])` for `conversations` and `.optional()` for legacy fields to handle both formats.

## Architecture Pattern Evaluation

| Option | Description | Strengths | Risks / Limitations | Notes |
|--------|-------------|-----------|---------------------|-------|
| Inline conversation logic in sessions.ts | Add conversation functions to existing sessions module | Simple, follows flat lib pattern | Module grows large | Matches current project style |
| New conversations.ts module | Separate module for conversation CRUD and auto-import | Clear responsibility boundary | Introduces new module | Better for new domain concept |
| conversation-discovery.ts + conversations.ts | Split discovery (filesystem scanning) from CRUD | Maximum separation | Two new files may be overkill | Discovery logic is complex enough |

## Design Decisions

### Decision: Separate conversations.ts module

- **Context**: Conversation management introduces significant new logic (CRUD, auto-import, discovery)
- **Alternatives Considered**:
  1. Add to sessions.ts — keeps single module but bloats it
  2. New conversations.ts — clean boundary for new domain concept
- **Selected Approach**: New `conversations.ts` module for conversation CRUD and auto-import
- **Rationale**: Discovery/import logic is substantial and conceptually distinct from session lifecycle. The flat lib pattern is maintained (single `src/lib/` directory).
- **Trade-offs**: Two modules now touch session state, but clear ownership (sessions.ts for session-level, conversations.ts for conversation-level)

### Decision: Read-time migration for backward compatibility

- **Context**: Existing state files have per-session conversation data that must move to Conversation records
- **Alternatives Considered**:
  1. Offline migration script — explicit but requires manual execution
  2. Read-time migration — transparent, automatic, no user action needed
- **Selected Approach**: Read-time migration via Zod schema defaults and a `migrateSessionState()` utility
- **Rationale**: CC is a local-first tool with no deployment pipeline. Users should not need to run migration commands.
- **Trade-offs**: Slightly more complex schema parsing; legacy fields kept as optional in schema for compatibility

### Decision: Session-level locking for conversations

- **Context**: All conversations in a session share one worktree. Should locking be per-conversation or per-session?
- **Selected Approach**: Keep session-level (worktree-level) locking
- **Rationale**: Concurrent Claude CLI processes in the same worktree would cause file conflicts. One prompt execution at a time per worktree is the correct constraint.

## Risks & Mitigations

- **State file growth** — Each conversation stores its own messages array. Mitigation: messages are typically short; monitor file size in production use.
- **sessions-index.json availability** — Not all Claude Code projects have the index. Mitigation: JSONL fallback parsing, with efficient first-entry-only reads.
- **Race condition during auto-import** — Concurrent page loads could import the same session twice. Mitigation: deduplicate by Claude Code session ID before creating Conversation records.
- **Breaking change to SessionState schema** — Existing code consuming `session.status`, `session.messages` etc. will break. Mitigation: derive these as computed properties for backward compatibility during transition.

## References

- Claude Code CLI `--session-id` flag — for targeting specific sessions
- `~/.claude/projects/` directory structure — session storage convention
- `sessions-index.json` schema — fast metadata lookup for auto-import
