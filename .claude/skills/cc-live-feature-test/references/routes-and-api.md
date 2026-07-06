# CC Routes & Fixture API Cheat Sheet

Deep-link URLs and REST contracts for seeding/tearing down live-test state. Base URL comes from `cctl dev ensure <server>` (`localUrl`, e.g. `http://localhost:3001`) — never assume a port. Prefer `cctl fixture` commands over raw curl where they exist; the contracts below are the fallback and the source of truth for what those commands do.

## Page routes (deep-link instead of click-navigating)

| URL | What it shows |
|---|---|
| `/projects` | Projects list |
| `/projects/<name>` | Project detail (cockpit). `?focus=<conversationId>` auto-opens a project conversation |
| `/projects/<name>/<session>` | Session page (conversation list + composer) |
| `/projects/<name>/<session>/diff` | Session diff |
| `/projects/<name>/<session>/conflicts` | Merge conflicts |
| `/projects/<name>/<session>/workflow` | Graph-workflow view |
| `/conversations` | Cross-session conversations workspace |
| `/conversations?c=<conversationId>` | Open a specific conversation (shallow selection) |
| `/conversations?c=<cid>&m=<messageId>` | Deep-link to a specific message |
| `/conversations?project=<p>&session=<s>` | Filtered to one session |
| `/config` | Global config UI |

Param parser (source of truth): `src/lib/conversations/hrefs.ts` (`parseConversationsPageParams`).

## REST contracts for test fixtures

All paths relative to the dev server base URL. Local requests need no auth token (a token exists at `<worktree>/.config/api-token` if an endpoint ever returns 401).

### Create session — returns a ready conversation
```
POST /api/projects/<name>/sessions
{"mode":"normal","sessionName":"<orthogonal-name>"}
```
201 → `{sessionName, worktreePath, branchName, conversations: [{id, name, status, ...}], ...}`.
The response **already contains a usable conversation id** — do not create one separately for a basic test.

### Delete session — query param, NOT path param
```
DELETE /api/projects/<name>/sessions?sessionName=<s>
```
200 → `{"success": true, "worktreeRemoved": <bool>}`. A path-param form (`DELETE .../sessions/<s>`) silently does nothing — this mistake has burned real sessions.

### Create an extra conversation in a session (e.g. per-backend tests)
```
POST /api/projects/<name>/sessions/<session>/conversations
```
201 → `ConversationState`. Backend is selectable only while a conversation is fresh (locks after the first turn).

### Run a prompt (SSE stream — do not wait on the response body)
```
POST /api/projects/<name>/sessions/<session>/conversations/<cid>/prompt
{"prompt":"<text>"}
```
Response is a `text/event-stream`; execution continues server-side if you disconnect. To run-and-wait: POST with a short `--max-time`, ignore the curl exit code, then poll status (below).

### Poll turn status
```
GET /api/projects/<name>/sessions/<session>/conversations
```
→ `ConversationState[]`; find your id and read `status`: `new | awaiting | running | waiting_for_input`. A finished turn is `awaiting` (or `waiting_for_input` if the agent asked something). Poll every 1–2s.

### Read what the agent actually saw/produced
- Messages API: `GET /api/projects/<name>/conversations/<cid>/messages` → ordered `TranscriptMessage[]` (has `seq`).
- Transcript JSONL on disk: `<configDir>/transcripts/<conversationId>.jsonl` (grep-friendly; the durable source of truth).

### Archive a conversation (there is no DELETE)
```
PATCH /api/projects/<name>/sessions/<session>/conversations/<cid>/archive
{"archived": true}
```

### Project-level conversations (no session)
- Create: `POST /api/projects/<name>/conversations` → 201 `ConversationState`
- Prompt: `POST /api/projects/<name>/conversations/<cid>/prompt` (same SSE behavior)
- List: `GET /api/projects/<name>/conversations`

## Stable selectors (`data-testid`, live-verified)

| Testid | Element | Where it renders |
|---|---|---|
| `conversation-list` | conversation-cards grid | session page (`/projects/<p>/<s>`), non-empty state only |
| `conversation-row` | per-conversation card link | session page |
| `session-card` | per-session row/card | project detail page (`/projects/<p>`) |
| `prompt-input` | composer editable element | conversation workspace (`/conversations?c=…`), NOT the session list page |
| `prompt-send` | send/queue button | conversation workspace; desktop button only (a CSS-hidden mobile twin exists without the testid, so `getByTestId` stays strict-mode unique) |
| `message-row` | per-message row | conversation transcript (main panel, panes, sidebar peek) |

`prompt-input` is a TipTap **contenteditable div**, not a `<textarea>` — Playwright `fill`/`type`/`getByTestId(...).fill(...)` work on it; `querySelector('textarea')` finds nothing.

## Durable state locations (worktree-local dev server)

The dev server runs with `CC_CONFIG_DIR=<worktree>/.config`:

- SQLite DB: `<worktree>/.config/command-center.db`
- Transcripts: `<worktree>/.config/transcripts/<conversationId>.jsonl`
- NDJSON logs: `<worktree>/.config/logs/`
- Dev-server stdout (incl. HTTP access log + compile times): `<worktree>/.cc/dev-server-logs/<server>.log`

Verify you are pointed here — not at `~/Library/Application Support/cc` — before mutating anything (see SKILL.md Step 0).
