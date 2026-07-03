# CC CLI Migration — Post-Merge Live Verification Checklist

**Status:** REQUIRED before the migration is considered live.
**Why this document exists:** the migration workflow ran inside a session worktree while the live
CC orchestrator executed the *main-worktree build* — a build that predates every endpoint and
binary this migration ships. The workflow cannot restart its own orchestrator, so nothing below
could be verified against the real running instance from inside the workflow. Every item was
verified as far as possible in-worktree (unit/contract suites green; `cctl doctor` green against a
worktree `next dev` instance on port 4611 with a worktree-local config dir), but **none of it has
run on the live build**. Each item below is therefore explicitly marked *impossible to run inside
the workflow* and must be executed live, in order.

Conventions: run agent-side commands from inside a CC session conversation (the env contract —
`CC_SERVER_URL`, `CC_API_TOKEN`, `CC_PROJECT`, `CC_SESSION`, `CC_CONVERSATION_ID`, PATH prepend —
is injected at spawn, so bare `cctl` resolves). Server-side checks use the live config dir
(macOS: `~/Library/Application Support/cc`).

---

## 1. Merge, rebuild, restart the main CC instance

*Impossible in-workflow: the workflow cannot merge its own branch or restart the orchestrator that runs it.*

Steps:
1. Merge the session branch (`csm/replace-mcp-with-cli-0cecd5*`) to `main` via the CC merge flow.
2. Run the `cc-rebuild-restart` skill (it performs `bun install` + `bun run build` in the MAIN
   worktree and, only on build success, restarts the running CC server as a detached daemon).

Pass criteria:
- Build succeeds — note that `bun run build` now includes `build:cli`, emitting
  `dist/cctl/cctl.mjs`.
- Server restarts and the startup log shows the token + install steps ran: look for the
  agent-gateway startup events (token provisioning and cctl install) with no
  `startup.agent_token_failed`.
- `<configDir>/api-token` exists with mode `0600`; `<configDir>/bin/cctl` exists with mode `0755`
  and its build stamp matches the deployed build
  (`head -c 200 "<configDir>/bin/cctl" | cat` shows the shebang;
  `node "<configDir>/bin/cctl" --version` if available, or rely on item 2's doctor output).

## 2. `cctl doctor` green inside a freshly created session

*Impossible in-workflow: proves install + env injection + handshake on the live build, which the workflow could not restart.*

Steps:
1. Create a brand-new session from the CC UI on any project.
2. In its conversation, prompt the agent to run exactly: `cctl doctor`.

Pass criteria (all four lines):
- `server` shows the live instance URL (from injected `CC_SERVER_URL`).
- `server build` and `cli build` stamps are **identical** (server-owned binary contract).
- `identity` shows the real `project=<name> session=<name> conversation=<id>` — not `-` — proving
  env injection at the spawn seam.
- `token valid (source: env)` and exit code 0.

## 3. Ask → push → answer from UI → new turn (doc 03 §9 scenario 1)

*Impossible in-workflow: needs the live conversation machine, a real phone push, and the real UI answer path.*

Steps:
1. In an interactive session, prompt the agent: "Use `cctl ask` to ask me one multiple-choice
   question (any topic), then end your turn as instructed."
2. Observe the agent run `cctl ask` (via `--file` or `--question/--option` sugar), print the
   registration message, write a handoff note, and end its turn.
3. Confirm the phone push arrives ("Session <s> needs your input").
4. Answer from the UI panel.

Pass criteria:
- CLI output contains "Question batch q_… registered" + the end-turn instruction; the turn ends
  (conversation status becomes `waiting_for_input` with **no running turn** — no stop control).
- Push notification received on the phone.
- The question panel renders from persisted `pendingQuestions`.
- Answering starts a **new turn** whose user message contains the
  `<cc-question-answers batch="q_…">` block (verify in the transcript JSONL), rendered as an
  answer card in the UI, and the agent's reply demonstrably uses the selected answer.

## 4. Server restart while a question pends (doc 03 §9 scenario 2)

*Impossible in-workflow: requires restarting the live server, which would kill the workflow itself.*

Steps:
1. Repeat item 3 steps 1–2 (question registered, turn ended, do **not** answer).
2. Restart the CC server (relaunch the daemon; the `cc-rebuild-restart` skill's restart step, or
   your normal restart path).
3. After startup, open the conversation — the question panel must still render.
4. Answer from the UI.

Pass criteria:
- After restart, the conversation wakes in `waitingForInput` (panel visible, status
  `waiting_for_input`) — rehydration from the persisted machine snapshot.
- The answer is **not** discarded (the old build returned HTTP 410 here): a new turn starts with
  the answer block, and the SDK session resumes with full history (`backendRef` → `resume:`; the
  agent's reply shows it remembers the pre-restart context).

## 5. Normal message instead of an answer → supersede, no stall (doc 03 §9 scenario 3)

*Impossible in-workflow: exercises the live queue-drain path in `waitingForInput`.*

Steps:
1. Repeat item 3 steps 1–2 (question pending, no answer).
2. Type a normal instruction into the prompt box instead of answering (e.g. "Skip the question,
   just summarize the repo layout.").

Pass criteria:
- The message is **not** stalled: a turn starts promptly (the `waitingForInput` entry drain).
- The question panel dismisses on the status SSE (pending question cleared/superseded at turn
  claim).
- A subsequent duplicate answer attempt (if the panel were still open in a second tab) gets
  HTTP 410 "already answered or superseded", not a crash.

## 6. Answer while the asking turn is still streaming (doc 03 §9 scenario 4)

*Impossible in-workflow: a live race between the streaming turn and the answer POST.*

Steps:
1. Prompt the agent: "Run `cctl ask` to ask me a question, then — ignoring the end-turn
   instruction for this test — continue by writing a long summary of the project."
2. While the turn is still visibly streaming, answer the question from the UI panel.

Pass criteria:
- The answer POST succeeds (200) while the turn runs; the pending question clears (panel
  dismisses).
- The answer is FIFO-queued: when the streaming turn finalizes, the machine goes to `idle`
  (guard sees no pending question) and the queue drains — the answer turn follows immediately
  after finalize, containing the `<cc-question-answers>` block.
- No stall, no dropped answer, no double-delivery.

## 7. Live lane-tool check: graph workflow completes a task via `cctl`

*Impossible in-workflow: lane conversations must be spawned by the live orchestrator with the lane env vars (`CC_WORKFLOW_EXECUTION_ID`/`CC_WORKFLOW_CONTEXT_ID`).*

Steps:
1. In a session, author a trivial plan (one context, two tasks, no validators beyond defaults) as
   `plan.json`, then: `cctl workflow validate --file plan.json` →
   `cctl workflow create --file plan.json` → `cctl workflow start <id>`.
2. Let the lane run; watch with `cctl workflow status` and the graph page.

Pass criteria:
- The lane agent completes tasks via `cctl workflow task complete --summary …` (visible in the
  lane transcript), each completion followed by the `hint: N task(s) remain in this context` line.
- The workflow reaches `completed`; task summaries appear in the execution record.
- **Rotation-gate or halt observation (one of the two, whichever is feasible):**
  - Rotation gate: set a low context limit for the lane context so a mid-turn completion trips
    `evaluateMidTurnContextLimit` — the CLI must print the CONTEXT LIMIT REACHED stop instruction
    verbatim (exit 0, **no** hint beside it) and the lane must end its turn and rotate.
  - Halt: pause the workflow (or trigger an approval gate) while the lane is mid-turn — the next
    `cctl workflow …` lane call must exit 1 printing the halt reason verbatim (HTTP 409
    `{ halt: true, reason }` under the hood).

## 8. Push-notification and dev-server smoke checks via `cctl`

*Impossible in-workflow: needs the live push config and the live dev-server manager.*

Steps and pass criteria:
1. `cctl notify "post-merge smoke test" --title "cctl"` from inside a session → exit 0 and the
   push arrives on the phone. (If push is deliberately unconfigured: exit 1 with a one-line
   reason — also a pass for the CLI contract, but then configure push and re-run for the full
   check.)
2. `cctl dev ensure` in a session on a project with `devServers` configured → blocks until
   liveness, prints the server block with `local:`/`remote:` URLs and the
   `hint: drive the app at <localUrl>…` line; the URL responds (`curl -s -o /dev/null -w "%{http_code}" <localUrl>` → 200).
3. `cctl dev list` shows the running server with the same URLs; `cctl dev stop <serverName>`
   stops it (exit 0; `cctl dev list` shows it stopped).

---

**The migration is not GO until every item above is checked.**
