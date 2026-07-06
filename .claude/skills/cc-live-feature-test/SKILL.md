---
name: cc-live-feature-test
description: This skill should be used when verifying a Command Center (CC) feature works end-to-end with a LIVE test — driving the real running app with Playwright and real LLM calls, then confirming behavior against backend state (SQLite, NDJSON logs, transcripts, API) rather than the UI alone. Triggers on "live test this feature", "verify it actually works", "end-to-end verify with real LLM", "test <feature> with Playwright", "confirm this works in the real app", or validating a feature before a branch is considered done. Not for unit/integration tests (those run against fakes) — this is for proving real behavior.
---

# Command Center — Live Feature Verification

Unit and integration tests in CC frequently pass against **fakes** (in-memory stores, mocked runtimes) while the real wired-up path is broken. The whole point of this skill is to prove a feature works in the **running system** with **real LLM calls**, and to confirm every claim against **durable backend state**, not the screen.

Two references carry the mechanics — read them before driving anything:

- `references/routes-and-api.md` — deep-link URL table, REST fixture contracts, and durable-state file locations. Eliminates URL/endpoint guessing.
- `references/playwright-recipes.md` — verified playwright-cli idioms (wait, snapshot, eval) and their gotchas, plus dev-mode timing expectations.

## The default verification shape

This is the known-good loop — an efficient round is ~7 browser calls:

1. `cctl dev ensure <server>` → the session-scoped `localUrl`.
2. **Seed over the API, not by click-driving**: `cctl fixture session create <scratch-project> --json` returns a ready `conversationId`, deep-link `urls`, and the dev `dbPath`/`transcriptPath` — and pre-warms the routes so the first navigation is fast. Run turns with `cctl fixture prompt … --wait`. (Full verbs: the cc-cli skill.)
3. **Deep-link** the browser straight to the target URL from the fixture output.
4. Assert with **one-line `eval` probes returning tiny strings**; scope snapshots to elements; wait with the `run-code` waitFor idiom (never `networkidle` — SSE keeps the network busy forever).
5. **Verify against durable state** — transcript JSONL, SQLite, API — never the optimistic UI alone.
6. Clean up: `cctl fixture session delete`, `playwright-cli -s=<name> close`.

## Core principles (read first)

1. **Live + real LLM, every time.** Drive the actual running app with Playwright and let real agent turns execute. No stubbed backends.
2. **Never trust the UI alone.** The client uses optimistic state — it will happily show something as "done", "queued", "saved", or "sent" that the server silently dropped. Every PASS must be backed by durable evidence: the SQLite DB, the NDJSON logs, the transcript JSONL, and/or the API response.
3. **A green test suite is not evidence.** If the suite passed but the live behavior fails, that's a finding (usually "tests exercise the mock, not production"), not a reason to doubt your live result.
4. **Verify the test target is safe.** Confirm you are pointed at a worktree-local database, NOT production (see Step 0). Live testing creates and deletes real sessions/conversations/prompts — doing that against the production DB is destructive.

## Step 0 — Safety: confirm you are NOT pointed at the production DB

`cctl dev ensure`'s **default behavior must create local configuration state in the current worktree** — i.e. start the dev server with `CC_CONFIG_DIR` resolving to `<worktree>/.config`, giving an isolated `command-center.db`, logs, and transcripts. Verify this before doing anything that mutates state.

- Production config dirs (DO NOT TEST AGAINST THESE):
  - macOS: `~/Library/Application Support/cc`
  - Linux: `$XDG_CONFIG_HOME/cc` or `~/.config/cc`
- Run `cctl dev list --json` and inspect the server `command` / `recentOutput`. Confirm it includes a worktree-local override, e.g. `CC_CONFIG_DIR=$PWD/.config`, and that the resolved path is **inside the current worktree**.

```bash
WT="$(git rev-parse --show-toplevel)"
# The worktree-local config dir the dev server should be using:
test -d "$WT/.config" && echo "local config dir present: $WT/.config"
# Confirm a worktree-local DB exists and is the one being written (watch mtime during the test):
ls -la "$WT/.config/command-center.db"
# Sanity: it must NOT be the production DB:
echo "production (must NOT be the target): $HOME/Library/Application Support/cc/command-center.db"
```

If `cctl dev ensure` did NOT produce a worktree-local `.config` (no `CC_CONFIG_DIR` override, or it points outside the worktree, or it resolves to a production path), **STOP and surface it** — both because live testing would corrupt production data, and because that default behavior is itself a defect worth reporting. Do not proceed until the target is a worktree-local DB.

## Step 1 — Environment setup

1. **Get the URL with `cctl dev ensure`.** Never assume a port (3000/3002/6006): every worktree gets its own. Use the printed `localUrl`/`remoteUrl`. `cctl dev list --json` also gives `logFilePath` (the dev server's stdout/stderr — useful for startup/runtime errors and the HTTP access log).
2. **Locate the durable state** (all under the worktree-local config dir from Step 0):
   - SQLite DB: `<config>/command-center.db` (e.g. `sqlite3 <config>/command-center.db ".tables"`)
   - NDJSON logs: `<config>/logs/...` — use the **`debug-logs` skill** for structure, locations, `traceId` tracing, and query recipes. Don't re-derive log layout here.
   - Transcripts: `<config>/transcripts/<conversationId>.jsonl` — the source of truth for what the agent actually saw and produced.
3. **Drive the browser with the `playwright-cli` skill**, using a named session (e.g. `playwright-cli -s=cclive open --browser=chrome <url>`). It keeps one browser across calls — right for multi-step, timing-sensitive flows. Prefer snapshots/`eval` over screenshots.
4. **Use a scratch project** (one set aside for testing, with no real work in it). Create a throwaway session for the test.
5. **Name test sessions/conversations so they don't collide with your greps.** If you'll grep logs for `"foo"`, don't name the session `foo-test` — every line will match. Pick an orthogonal name.

## Step 2 — Drive the feature (real LLM) with Playwright

Exercise the actual user flow. Common gotchas when a feature depends on an **in-flight agent turn**:

- **Keep the turn genuinely running for as long as you need.** Do NOT make the agent `sleep` to stall it — the harness **blocks foreground `sleep`**, so the agent backgrounds the command and settles the turn early, collapsing your window and silently changing which code path runs. Instead, give a long **pure-text streaming** task with no tools, e.g. *"Without using any tools, write a detailed 2500-word essay on <topic>; one continuous response, don't stop early."* Streaming output keeps the turn active for 30–60s.
- **Confirm the state you depend on before acting.** If the flow requires "agent is working", verify it from the UI signals that reflect server state (e.g. a "Stop agent" control present, a send button whose label changes while running) AND, ideally, a log/API check — don't assume the turn started just because you submitted.
- **Backend coverage.** If the feature is backend-sensitive, test each backend (Claude, Codex). The backend selector is typically only editable on a **fresh conversation** (it locks once a turn starts), so create a new conversation per backend. Before relying on a backend, do a startup precheck: send one trivial prompt and confirm a real turn runs — some backends fail immediately on env/CLI config (check the conversation log for a `*-runtime.turn_error`). A backend that can't start is an environment issue to flag, separate from the feature under test.
- **Use unique, greppable markers in your inputs** and, where possible, ask for an answer that won't appear by coincidence (e.g. an arithmetic result), so you can unambiguously find both the input and the agent's response in the transcript.

## Step 3 — Verify against backend state (the actual test)

For each behavior you claim, gather durable evidence. The UI is a hint; these are proof:

- **NDJSON logs** (via the `debug-logs` skill): trace the action by `traceId` from `request.start` → module events → `request.complete`. Distinguish *which API path* actually ran (the optimistic UI can make a dropped action look successful — confirm the expected POST/PUT actually fired and returned 2xx). Watch for the absence of an expected event (silent loss often logs nothing at warn/error).
- **SQLite DB:** query the relevant table(s) and confirm the row(s) reflect the change. Re-read after the action — confirm it *persisted*, not just that an in-memory copy changed.
- **Transcript JSONL:** confirm what the agent received and produced, in order, exactly once (no duplicates, no missing entries, nothing left dangling).
- **API responses:** fetch the same endpoints the UI uses and confirm the server's view matches the claim.

Reconcile the UI against the backend. If the screen says success but the DB/logs/transcript disagree, **the backend is the truth** and you've found a bug.

## Step 4 — Persistence/round-trip caution

A feature can pass its whole test suite and still lose data, because the tests use an in-memory fake store that preserves fields the **real persistence layer drops**. When a feature persists new state, verify the round-trip explicitly:

- Check the real DB schema actually has columns/storage for the new state (`sqlite3 <db> ".schema <table>"`), and that the repo's **write mapping AND read mapping** both handle it. A Zod schema field with a `.default(...)` will silently reset to the default on every read if the read mapping omits it — making loss invisible.
- For a deterministic, timing-independent repro, add/run a contract test that exercises the **real** repo round-trip (write → read-back → assert the value survived), not a fake store. A failing round-trip test is the cleanest possible evidence.

## Step 5 — Clean up

- Delete the throwaway test session/conversations (`cctl fixture session delete <project> <session>`), or clearly flag what you left behind and why.
- If you added a repro test or any temporary file, say so explicitly and ask whether to keep or revert it.
- Close the Playwright session when done (`playwright-cli -s=<name> close`), unless leaving it open helps the user inspect.
- Stay within the worktree. Do not modify the production config dir or anything outside the worktree without explicit permission; if the feature needs a global config change to test, ask first.

## Reporting

State plainly, per scenario and per backend, whether it works — each PASS cited to durable evidence (specific log lines, DB rows, transcript entries, API responses). If it's broken, give the root cause with `file:line` and a deterministic repro. Never report success on the strength of the optimistic UI alone. If you couldn't test something (e.g. a backend that can't start in this environment), say so and why, rather than implying coverage you didn't achieve.
