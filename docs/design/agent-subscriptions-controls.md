# Subscription and inbox controls

Ticket: command-center#170. Builds on passive subscriptions (#167–168) and finite active waits (#169).

## Experience

`/subscriptions` is the shared overview for global, project, session, conversation, and source scopes. The top navigation opens the global view; session and conversation headers open scoped controls. Source views expose followers for notepads, tickets, specs, and workflow executions. Every entry uses the same workspace and links to the full page. Desktop uses a list and inspector; narrow screens stack them and move the selected inspector into view.

The overview distinguishes follows, outstanding wake waits, pending deliveries, and items needing attention. Search, mode/state filters, and pagination bound large collections. A creation dialog chooses an ordinary recipient, a catalog source and selection, purpose, and mode. Active choices show their finite lifetime. Source links, event identities, retrieval commands, wait/batch state, and recipient links let the operator trace an update.

The inbox distinguishes runtime acceptance from human read state. Browsing, source previews, CLI inspection, and advisory hints never acknowledge agent delivery. Mark read/unread is an explicit human operation in a separate persisted receipt table. Accepted wake deliveries link to the corresponding transcript input; generated wake input has server-owned provenance and a compact receipt explaining why the turn started. Active Work shows outstanding waits rather than already settled history.

## Control semantics

- Passive follows deliver alongside the next user message. Subscription-generated and other machine turns do not consume unrelated passive updates.
- Pause suspends delivery while durable outcomes remain available. Finite expiry continues. Resume exposes retained outcomes; it does not renew the original deadline.
- Downgrade changes an outstanding wake into passive delivery of its one terminal outcome, retaining the same source and lifetime. Restoring an existing wake keeps its deadline.
- Cancel terminates a finite wait. Unfollow also remembers an opt-out against automatic involvement. Both preserve inspection history.
- A queued wake can be withdrawn only through the canonical queue's semantic operation before backend delivery. The queue row and selected wait change together; other batch members return to readiness. Dispatch, queue claim, and final admission recheck stale batch state.
- A wake whose delivery may already have started requires review. An orphan uncertain batch can be cancelled only after proving that neither a queue row nor a transcript acceptance receipt exists. Nothing is automatically replayed.
- A spent finite wait cannot be silently restored as a new wait or an ineffective passive follow. Its reason and lifetime remain immutable. Existing ordinary passive opt-outs can be explicitly followed again.
- Human questions, checkpoint and approval holds, active runtime ownership, and lane context boundaries continue to govern admission. Controls do not grant approval authority.

## Domain ownership

The subscription controls service owns mutations. Session and project route adapters share recipient resolution and principal checks; public targets use the existing scope union, never a placeholder session name. The catalog validates source identities, passive event selections, and the three supported active source kinds: workflow execution, validation run, and Git job.

The overview service is a read-only projection over subscription, wait, queue, source, and preference repositories. Global list reads do not reconcile, settle, or mark records. Background collection uses the existing reconciliation lifecycle to make passive pending counts available during long agent turns. Publications occur for changes, and typed SSE invalidates subscription queries; the UI does not poll every recipient independently.

The canonical queue registers a narrow withdrawal adapter with the subscription runtime. This keeps queue ownership intact without importing the full queue dependency graph into subscription involvement and service construction.

Migration 0060 persists conversation hint preferences and human delivery read receipts. Repository round-trip tests cover the new fields. The existing subscription and wait ledgers remain the source of delivery truth.

## Agent interface

The CLI exposes catalog, subscribe, list, detail, pause, resume, mode, cancel, unfollow, finite wait inspection, and inbox reads. Text and JSON use the same bounded projections with stable detail and pagination commands. Literal purpose text can come from a file. Unsupported selections fail before mutation.

Advisory hints default on for attributable ordinary conversations and advertise only a pending count and an explicit inbox read command. They never carry event contents, acknowledge delivery, or start a turn. A bounded summary read failure omits the hint; command-specific hints take precedence. Help and commands aimed at a different recipient do not trigger an inbox lookup. A persisted per-conversation control disables hints while preserving explicit inspection.

## Verification

Behavioral tests cover controls and shared-batch withdrawal, expiry and paused outcome retention, read receipts and preferences, catalog validation, route identity, CLI contracts and hint behavior, read-only overview projection, UI mutation/error states, and transcript deep links. Browser verification uses the isolated worktree dev instance, persisted API readback, and real agent input where wake provenance is involved. Screenshots cover desktop and narrow layouts, reachable host entries, source followers, and inbox/inspector states.

The live session created a follow through the UI, exercised pause → passive → restore wake → resume without changing the original deadline, and cancelled a second queued wait. An actual Codex conversation's pending question survived these controls and server restarts. Answering it produced the human-directed turn first, then exactly one validation wake; the cancelled source never appeared. The transcript receipt linked through the subscription and delivery history back to the exact resulting message. Transcript projection preserves a shared server-owned origin, while mixed-origin messages retain provenance on their individual parts.

CLI hints and explicit inbox reads left delivery states, attempt counts, and human read receipts unchanged. Marking an item read changed only its human receipt. Keyboard checks verified opening scoped controls with Enter and returning focus to the exact trigger with Escape. Desktop, 390px mobile, populated and empty states, source previews, and a recoverable request failure were inspected in the browser. Next.js diagnostics reported no configuration or session errors. Task-created fixtures, browsers, and dev servers were cleaned up after verification; the managing instance was not used for test data.


Validation completed September 30, 2026:

- Full suite `vrun-09eb3ed7-8ada-4b12-ac56-c38b4069e9e4`: 29,645 tests passed, six skipped, and 13 fixture assertions failed across four files. Eleven concerned CLI fixtures accounting for the new advisory summary request; two concerned the migration registry and a positional SQL fixture insert after adding pause state. These were corrected without changing production behavior.
- All affected fixtures plus the related ticket cursor suite passed in a five-file scoped rerun with `--require-match`: `vrun-62f7952c-333d-4ead-81f4-cf3ec6d4cec3`. The complete suite was not repeated after these fixture corrections.
- Full typecheck: `vrun-555e1448-52b5-4047-8a79-27c4ebe80e3b`; architecture seams: `vrun-a5848a33-73d3-463b-b0b7-700307e6abe9`; changed lint: `vrun-57657a86-20c3-4b40-b91d-f0bd3c7654e0`; changed format: `vrun-97d10076-b81a-40d9-914b-d4fe4a163434`. All passed.
