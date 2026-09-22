# Cursor Backend

Command Center runs Cursor as a third agent backend alongside Claude and Codex. Cursor is usable across the application: session and project conversations, one-shot tasks, every graph workflow role, native spec managed delivery, Collaboration Mode, and the agent-assisted product features (tickets, naming, compaction, commit and merge assistance, conflict resolution).

Where Cursor offers a weaker guarantee than Claude or Codex, Command Center keeps the feature available and says so: the difference appears as an informational execution warning wherever Cursor is selected, never as a disabled option or an acknowledgement gate. Instruction-only limits are described as instructions, and figures the provider does not publish stay unknown rather than estimated.

The verified capability matrix, one row per behavior with its evidence and its limits, is in [`reports/2026-09-21-cursor-parity-final-validation.md`](./reports/2026-09-21-cursor-parity-final-validation.md). The [declared capabilities](#declared-capabilities) table at the end of this page is generated from the registered backend descriptor, so it cannot drift from what the running application enforces.

---

## Authentication

Cursor is the first backend whose provider credential Command Center handles itself. Claude and Codex authenticate through their own CLI logins; Cursor does not.

**Set `CURSOR_API_KEY` in the environment of the Command Center server process.**

```bash
CURSOR_API_KEY=<your Cursor API key> bun run start
```

- The key is read from the server's own environment at the start of every Cursor worker — on the first turn of a conversation and on every resume — and is checked against Cursor's account endpoint before any conversation state is created or any billable turn runs. An absent, empty, or rejected key fails immediately with a bounded error naming which of the three it was; the key value itself never appears in a message, a log, a transcript, or an error.
- **Rotation takes effect at server restart.** There is no rotation UI and no reload signal: change the variable in the server's environment and restart Command Center.
- The key is never stored in a settings file. `agentBackends.cursor.apiKey` is rejected by name in both global settings and `CommandCenter.json`, and no API response or UI surface returns or renders it.
- **A logged-in Cursor CLI is not SDK authentication.** The two are separate credential surfaces; `cursor login` on the host does nothing for Command Center.
- The key reaches the worker over the private process IPC channel only. It is never placed in the worker's environment or its command line, precisely so the SDK cannot fall back to an ambient copy and so nothing the worker spawns can read it.

### Cursor workers inherit no credentials from the server

A Cursor worker runs model-chosen shell commands and MCP servers without a sandbox, and each of those inherits the worker's environment. Command Center therefore strips **every credential-shaped variable** — names containing `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, or `KEY`/`API_KEY` as a whole underscore-delimited segment — from the environment a Cursor worker is spawned with, not just `CURSOR_API_KEY`.

This is a deliberate asymmetry: **Claude and Codex sessions still inherit the server environment whole.** A Cursor agent cannot read `GITHUB_TOKEN`, `OPENAI_API_KEY`, or similar from its environment, so a tool or script that expects one will fail inside a Cursor conversation where it would work under the other backends.

Command Center's own session contract variables (`CC_SESSION`, `CC_API_TOKEN`, and friends) are unaffected — they are placed into the worker environment after the filter runs rather than inherited, so `cctl` works normally inside a Cursor conversation.

---

## Runtime requirements

The Cursor SDK is **pinned exactly**, and preflight fails closed on any other combination rather than trying it:

| | Required |
| --- | --- |
| Host | a matching `@cursor/sdk-${platform}-${arch}` package is installed |
| Node (the process running the worker) | **>= 22.13** |
| `@cursor/sdk` | **1.0.31** exactly — no range |
| The host's platform package | **1.0.31**, matching the SDK version |

Machine eligibility follows the SDK installation, not an acceptance-evidence allowlist. Command Center derives the platform package from Node's `process.platform` and `process.arch`; for example, Apple Silicon uses `@cursor/sdk-darwin-arm64`. The pinned SDK currently publishes these packages:

| Host | Platform package |
| --- | --- |
| macOS Apple Silicon (`darwin-arm64`) | `@cursor/sdk-darwin-arm64` |
| macOS x86_64 (`darwin-x64`) | `@cursor/sdk-darwin-x64` |
| Linux ARM64 (`linux-arm64`) | `@cursor/sdk-linux-arm64` |
| Linux x86_64 (`linux-x64`) | `@cursor/sdk-linux-x64` |
| Windows x86_64 (`win32-x64`) | `@cursor/sdk-win32-x64` |

Before a worker starts, Command Center verifies that the SDK's Node entry points, its lazily-loaded chunks, its declared dependencies, the derived platform package, and that package's executable native assets (ripgrep, the sandbox helper, the tree-sitter bindings, with their execute bits intact) are all present. A missing or mismatched artifact or a Node version below the floor produces a bounded error that names the mismatch — Cursor is simply unavailable on that machine, and nothing auto-updates or silently substitutes a different build.

Deployments that ship Command Center must package these dependencies rather than expect a runtime install.

---

## Models

The default model is **`composer-2.5`**, chosen explicitly on every run. Command Center never relies on Cursor's own auto-selection, and it never substitutes a different model for one you asked for.

Every model in the generated catalog is available to every project. A project turns models **off** in its `CommandCenter.json`:

```json
{
  "agentBackends": {
    "cursor": { "disabledModels": ["gpt-5.4"] }
  }
}
```

Omit the block and every generated model is offered. The complete selection for a turn resolves atomically: the selection chosen for the conversation → the global `agentBackends.cursor.modelSelection` → the generated catalog's default variant for `composer-2.5`. Its model must not be on the project's opt-out list, or the turn is refused with a client error **before any Cursor process starts**. A list naming every catalog model permits nothing. See [Project Configuration → `agentBackends.cursor`](./project-configuration.md#agentbackendscursor--cursor-disabled-models) for the full rules.

Command Center renders every user-selectable parameter advertised for the chosen model. Effort or reasoning appears beside the model picker; thinking, context size, fast mode, and future multi-value parameters appear under Model Options. Fixed parameters remain hidden in the UI but stay in the exact selection sent to Cursor.

Two consequences worth knowing:

- **The parameter catalog is generated, not discovered per request.** `bun run build` runs `cursor-models:sync`, which calls the authenticated `Cursor.models.list()` API and rewrites the checked-in catalog, so a build picks up whatever Cursor serves for the pinned SDK. Without `CURSOR_API_KEY`, or when the API is unreachable, the sync falls back to validating the checked-in artifact and the build continues — it never depends on a credential. `bun run cursor-models:refresh` forces the refresh on its own, and `cursor-models:check` validates without any network call. What still fails a build is an artifact that does not parse or was generated for a different SDK version.
- **A model the SDK itself rejects** (an id in the catalog that Cursor does not actually serve for your account) fails the turn with a bounded model-configuration error. It never falls back to `composer-2.5`, so the refusal surfaces as an error rather than as an answer from a model you did not ask for.

The composers offer exactly the models that survive the project's opt-out list. A globally configured model that does not is shown as an explicit invalid selection, in red, waiting for you to choose — not quietly replaced.

---

## Conversations

Session-scoped and project-scoped conversations stream text, thinking, and tool activity from Cursor, and every native envelope is persisted to the conversation transcript. Structured output (the shared contract every backend satisfies) is rendered into the prompt and validated after the turn; no native output schema is forwarded to the provider, so a malformed answer is caught after the turn rather than prevented during it.

### Continuity, restart, and forks

A Cursor agent id is a real provider handle: resuming a conversation returns to that exact session rather than replaying a reconstructed thread. The reference is persisted the moment Cursor issues it, mid-turn, so a server restart or a killed worker does not lose the conversation; the next prompt reloads the backend and its reference from SQLite and resumes the same agent in a new worker with the model, tool policy, MCP configuration, and permission policy reapplied. A reference that is genuinely invalid fails closed with a clear classification and is cleared; a transient failure keeps it.

Forks are **synthetic**: a fork seeds an independent agent and store with bounded transcript text from the source conversation, and the UI labels that seed as synthetic. Provider checkpoints and hidden state are not inherited, so a fork resumes from the visible transcript rather than from the source agent's internal state.

Command Center checkpoint capture, checkpoint forks, and handoff summaries are declared unavailable for Cursor. Those actions are withheld rather than offered and then failing; history zoom and checkpoint-based recovery remain Claude and Codex features.

### Queueing and in-turn steering

A message submitted while Cursor is working is stored durably and drained exactly once, keeping its model choice and images across cancellation and server restart. **Text is steered into the running turn** through the provider's steer API, with the acknowledgement correlated to the requesting run. Attachments, an unavailable runtime, and provider refusals fall back to the next turn. An acknowledgement lost after dispatch leaves delivery uncertain and holds the message for your review rather than resending it, because the provider offers no delivery idempotency key.

### Mid-turn questions

Cursor can ask you a question during a turn. It does so through Command Center's own `cc_question` tool over the SDK's supported custom-tool callback, using the existing question panel. A question expires after five minutes, only one batch is pending per conversation at a time, and a restarted server cannot reconnect an outstanding callback: its marker is retired and a late reply is refused. The provider's own interactive tools (`askQuestion`, `await`) stay denied; the SDK rejects native questions in both main-loop and subagent execution, so there is no provider-held request to bind to.

### Background work

Native subagent calls (the `task` tool) are tracked in a durable per-conversation store and published as live background activity. Automatic continuation happens inside the turn: the agent waits for its subagents and acts on their results before the turn ends. Tracking ends with the turn — a task still running when the turn ends is marked lost and disclosed to the next turn rather than continued, because the SDK offers no completion subscription once a run has ended. Cursor never produces a turn Command Center did not start.

---

## Image input

Cursor conversations accept images from the composer, and the image reaches the model through the SDK's own image path. Image-bearing turns stream and persist through exactly the same transcript contracts as text turns.

Bounds are enforced **before the turn starts**, so an oversized or malformed image is a client error rather than a failed billable turn:

| Bound | Value |
| --- | --- |
| Accepted formats | `image/png`, `image/jpeg`, `image/webp`, `image/gif` |
| Images per turn | 5 (the composer's own cap) |
| Decoded size per image | 5 MiB |
| Decoded size per turn | 20 MiB |

Errors name the offending image's position and the bound it broke. They never carry image bytes or the source path into logs or error messages.

---

## Tokens, cost, and context

Every finished Cursor turn reports **at most one** usage record, carrying the SDK's input, output, cache-read, cache-write, and total token counts, plus reasoning tokens when Cursor reports them. Following the SDK's own convention, the total **excludes** reasoning tokens. Cancelled, failed, and retried turns report no usage at all.

**Cost comes from the provider's billed-usage entries, not from token arithmetic.** A durable per-conversation ledger reconciles those entries against Command Center turns and settles late charges as they arrive. Two limits apply:

- The provider never links a billing entry to the run that produced it, so the per-turn figure is an attribution Command Center inferred; when it cannot be attributed it stays unknown.
- An account whose key cannot reach the usage endpoint (the provider answers `feature_unavailable`) records a durable unavailable state, the conversation shows a notice saying so, and cost stays unknown for that conversation. Nothing estimates a dollar figure from token counts, model names, or published rates.

**Context occupancy is unknown for Cursor.** The SDK publishes neither an effective context-window maximum nor current occupancy; the transcript header shows *Context unknown*, and billing token counts are never presented as a window measurement. Occupancy-driven rotation is therefore unavailable. When the provider produces a native context summary during a turn, Command Center records it as a durable conversation notice and sets the neutral compaction signal, which a configured context-limit policy can rotate on; the signal confirms that a summary was produced, not when or how well context was replaced.

---

## Tools, permissions, and policy

Cursor runs a fixed, non-interactive **bypass policy**. It is Command Center code policy, not a setting.

- **Sandboxing is off** and **auto-review is off**. Successful tool execution proves nothing about confinement.
- **Ambient Cursor settings are not loaded.** The worker attaches with empty setting sources, so user, project, and MDM Cursor settings on the host cannot change what a Command Center run does. Command Center never reads or writes your Cursor configuration.
- **`askQuestion` and `await` are denied** in the main loop; questions go through Command Center's own tool instead (see [Mid-turn questions](#mid-turn-questions)). A subagent launched through `task` keeps its own platform-curated toolset; if one surfaces an interactive request anyway, nothing waits on it and the turn ends as a bounded failure through the ordinary stall bound.
- **Governed instructions are advisory.** The SDK exposes no system or developer instruction field, so Command Center delivers governed instructions as a fenced *System Instructions* block at the head of the first user message, on create and on resume. The block has no system priority; the model may weigh it against the rest of the conversation.
- **Filesystem write policies are instruction-only.** A write policy supplied to Cursor is translated into explicit instructions, and both facets declare the restriction as instruction-only, so no consumer mistakes it for an enforced envelope. A Cursor agent can write outside its allowed paths; a policy that cannot be expressed at all is refused at the adapter boundary rather than silently dropped.
- **Network access and native tool approvals are not restricted.** Treat a Cursor turn as an unsandboxed agent on the host.
- **Provider-native memory cannot be disabled.** The SDK carries no memory field an embedder can set. Command Center delivers its shared-memory policy as an instruction — use Command Center memory, do not read or write Cursor-native memories — and cannot read the provider's memory state back to confirm compliance.

Every one of these limits is stated in Cursor's **execution warnings**, shown wherever Cursor is selected. None of them disables a supported feature or demands an acknowledgement.

### MCP

**stdio, streamable HTTP, and SSE** servers all reach a Cursor turn through the worker's MCP bridge, which Command Center owns. Per-tool allow and deny lists are enforced by that bridge in front of every transport, so a filtered tool is never reachable from the agent — the filter covers the tools the bridge exposes rather than being enforced inside the provider. A disabled server is omitted from the emitted configuration, and a configuration change takes effect on the next turn (there is no live apply to an idle Cursor runtime the way Claude has). Tool inventory comes from a direct probe Command Center performs, with configured startup and per-tool deadlines enforced by the bridge.

Strict MCP authority is **not** claimed: the provider exposes no way to read or override account-level MCP administration, so the configuration you see is what Command Center supplied, not necessarily everything the agent can reach.

### Skills, plugins, agents, and slash commands

Command Center's immutable managed skill bundle reaches Cursor conversations and tasks, alongside project and user skills discovered from disk, while ambient provider settings stay suppressed. Skills are delivered as a rendered catalog in the session instructions rather than as provider-native skill objects, and the catalog is capped at 16 KiB. Skills, plugins, and agents resolve through the shared capability cascade and are applied when the next conversation starts; a change made mid-conversation is deferred rather than applied live, and plugin rules, hooks, and commands are not translated.

The command palette lists the built-in commands Cursor can actually execute, and skill-derived commands share its `/` prefix.

---

## One-shot tasks and agent-assisted features

Cursor runs one-shot tasks on the same supervised worker, in both the standard and the isolated profile, with full model selection, cancellation, stall handling, and a task transcript. `cctl agent run` and the agent-runs API accept Cursor through the same admitted task path as any other backend, and workflow and collaboration consumers resolve a real continuity binding (conversation identity, working directory, store, validated model).

With Cursor as the configured backend, these product features run on Cursor rather than refusing or borrowing another backend: `/ticket` from a conversation, Quick Ticket enrichment, conversation and session naming, compaction generation, the `/commit` and `/merge` message, Smart Commit and Smart Merge validation fixes, and conflict analysis and resolution.

---

## Graph workflows and spec delivery

Cursor is assignable as a graph workflow implementer, validator, plan-repair agent, and collaboration second agent, in the schema, the assignment editor, and the config cascade. Validator, advisory-response, output-capture, and plan-repair runs execute on Cursor, inheriting the assignment's backend.

Path-owned and read-only placements accept Cursor: the same write envelope Claude receives is composed, delivered, and briefed in the implementer prompt. Because that envelope is delivered as instructions, a Cursor lane can write outside its owned paths; ownership violations are detected after the fact rather than prevented, and the builder shows an informational note saying so. A native spec's managed delivery workflow can be staffed with Cursor, and that staffing survives freeze, reload, and reopen.

---

## Collaboration Mode

Cursor participates in Collaboration Mode in either position: a Cursor conversation can start `/collab`, and Cursor can be picked as the second agent of any Claude, Codex, or Cursor conversation. Graph-workflow collaboration accepts Cursor as `secondAgent`; Agent One then runs Cursor's default partner, Claude. The supported pairs are listed explicitly in `src/lib/workflows/collaboration/backend-pair.ts`.

A Cursor lane runs as a Cursor task in the session worktree with the same autonomous settings every collaboration task lane gets. What differs is what Cursor can enforce:

| Aspect | What a Cursor lane does |
| --- | --- |
| **Continuity** | Agent One resumes the originating Cursor conversation's agent when the run grants it the session's CC scope (standalone `/collab`); every later phase resumes the lane's own task ref. Graph-workflow lanes start fresh. |
| **Handoff** | A Cursor agent is bound to one live worker under one owner. Once the run has claimed the conversation, it releases the conversation's own idle worker before Agent One's first turn, so `/collab` works immediately after a Cursor turn; the conversation opens a fresh worker on its next prompt. A conversation that still has a turn in flight fails the run instead. |
| **Sandbox, approvals, web search** | Delivered as instructions, not enforced; the run logs `cursor.task_policy_instruction_only`. The `/collab` row shows Cursor's execution warnings next to the second-agent picker. |
| **Cost** | Token usage is attributed to the Cursor lane; cost stays unknown unless the provider's billed usage attributes it. |
| **Structured output** | The shared prose-then-format flow and post-validation gate, as for Codex. |

---

## Conversation lifetime and cancellation

Each active Cursor conversation runs in exactly one supervised Node worker process of its own, with its own working directory, process group, agent store, and identity. Two conversations never share a worker or observe each other's state.

- **Stop** cancels natively, waits for the agent and worker to tear down, escalates to the worker's own (ownership-verified) process group if the wait is exceeded, and only then reports the conversation closed. Cancellation also stops a running shell descendant and a blocked MCP call. Deleting a session waits for that teardown before removing the worktree the worker is using.
- A worker whose Command Center server dies — even by `SIGKILL`, with no orderly shutdown — **terminates itself and its process group** within a bounded interval. There is no orphan sweeper to depend on.
- An idle worker is reaped after **5 minutes** of inactivity. Resuming the conversation simply starts a fresh worker from the persisted session reference.
- A turn that goes quiet for **20 minutes** settles as a bounded stall failure rather than holding the conversation open.

---

## Declared capabilities

The table below is rendered from Cursor's registered backend descriptor and is checked against it by `src/lib/agent-backends/cursor/acceptance/parity-matrix.test.ts`; edit the descriptor, not this table. `instruction-only` means Command Center asks the agent to observe a limit it cannot enforce; `false` or `unavailable` means no supported mechanism exists and the value stays unknown rather than approximated.

<!-- cursor-capability-disclosure:begin -->
| Declared capability | Value |
| --- | --- |
| `conversation.execution.classes` | ordinary-conversation, governed-execution |
| `conversation.execution.instructionDelivery` | user-message |
| `conversation.capabilities.queue.acceptsWhileRunning` | true |
| `conversation.capabilities.queue.deliveryTiming` | in_turn |
| `conversation.capabilities.continuationStrength` | precise_session |
| `conversation.capabilities.fork` | synthetic |
| `conversation.capabilities.structuredOutput` | post_validation |
| `conversation.capabilities.contextWindowMetrics` | false |
| `conversation.capabilities.nativeMidTurnAskUser` | false |
| `conversation.capabilities.externalTurns` | false |
| `conversation.capabilities.checkpoint` | false |
| `conversation.capabilities.checkpointFork` | false |
| `conversation.capabilities.handoffCapture.available` | false |
| `conversation.capabilities.handoffCapture.mode` | null |
| `conversation.capabilities.handoffCapture.reason` | Capture is unavailable |
| `conversation.capabilities.capabilityKinds` | skills:next_conversation, plugins:next_conversation, agents:next_conversation |
| `conversation.fsWriteRestriction` | instruction-only |
| `tasks.execution.classes` | nongoverned-task, governed-execution |
| `tasks.execution.profiles` | standard, isolated-one-shot |
| `tasks.execution.instructionDelivery` | user-message |
| `tasks.fsWriteRestriction` | instruction-only |
| `tasks.structuredOutput` | post_validation |
| `managedSkills.conversations` | bundled |
| `managedSkills.tasks` | bundled |
| `nativeMemory.mechanism` | none |
| `nativeMemory.reason` | Cursor native memory cannot be disabled or verified through the SDK. CC shared-memory policy is instruction-only; native memory may remain active. |
| `mcp.strictAuthoritativeConfig` | false |
| `mcp.serverDisable` | omit |
| `mcp.betweenTurnApply` | next-turn |
| `mcp.transports.stdio` | true |
| `mcp.transports.streamable-http` | true |
| `mcp.transports.sse` | true |
| `mcp.toolFiltering.mode` | bridge |
| `mcp.toolFiltering.byTransport.stdio` | bridge |
| `mcp.toolFiltering.byTransport.streamable-http` | bridge |
| `mcp.toolFiltering.byTransport.sse` | bridge |
| `mcp.toolDiscovery.preferred` | probe |
| `mcp.toolDiscovery.probeFallback` | true |
<!-- cursor-capability-disclosure:end -->

---

## What Cursor does not do

These are the rows of the parity matrix that remain unresolved: each is a provider gap Command Center discloses and works around rather than a feature it withholds. Claude/Codex parity is not claimed.

| Limit | What Command Center does instead |
| --- | --- |
| **Native mid-turn questions** | Asks through its own `cc_question` tool over a supported callback (five-minute expiry, one batch per conversation, no survival across a server restart). |
| **Provider-originated turns** | Instructs the agent to finish background work inside its turn; work that finishes after a turn ends cannot wake the conversation. |
| **Authoritative MCP configuration** | Supplies servers inline with ambient sources suppressed and declares the result non-authoritative. |
| **Exact per-turn cost** | Attributes billed-usage entries to turns from a durable ledger and leaves an unattributable figure unknown. |
| **Context-window metrics** | Shows *Context unknown*; reports a native compaction summary as a notice and a neutral signal. |
| **Privileged instruction delivery** | Delivers governed instructions as a fenced block in the first user message, without system priority. |
| **Filesystem confinement** | Translates the write policy into instructions and declares the restriction instruction-only on both facets. |
| **Disabling provider-native memory** | Delivers the shared-memory policy as an instruction and cannot read the provider's memory state back. |

---

## Verifying a deployment

The authenticated live matrix is the registered `cursor-acceptance` validation command:

```bash
cctl validate run cursor-acceptance --queue-if-busy --json
```

It exercises the real SDK against a real account on the machine where it runs: preflight taxonomy, two-conversation isolation, streaming and file operations, continuation and invalid-reference handling, model selection, MCP transports and filtering, instruction delivery on resume, native-memory fallback, billing, generation/shell/MCP cancellation with host process scans, worker lifetime bounds, image input, usage, and a closing credential sweep that also checks every live case the parity matrix cites was produced as a pass by that run. Its evidence is diagnostic and does not admit or deny machines in production.

Without `CURSOR_API_KEY` it exits **78** and reports `verdict=blocked reason=credential_absent` — deliberately neither pass nor fail, so a blocked run can never be mistaken for green evidence. It is not part of any merge gate, because a merge gate must not depend on a credential.

The most recent authenticated run, together with the application pass it accompanied, is recorded in [`reports/2026-09-21-cursor-parity-final-validation.md`](./reports/2026-09-21-cursor-parity-final-validation.md). The original Phase 1 run is preserved in [`plans/command-center-59-cursor-backend/PHASE1_ACCEPTANCE_EVIDENCE.md`](./plans/command-center-59-cursor-backend/PHASE1_ACCEPTANCE_EVIDENCE.md).

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Every Cursor turn fails immediately with a credential error | `CURSOR_API_KEY` is absent, empty, or rejected in the **server's** environment. A logged-in Cursor CLI does not count. Restart the server after setting it. |
| Cursor turns fail with a runtime/platform error | The worker's Node is below 22.13, or `@cursor/sdk` / the derived `@cursor/sdk-${platform}-${arch}` package at 1.0.31 is missing, mismatched, or incompletely extracted. |
| The model selector shows a model in red | This project's `agentBackends.cursor.disabledModels` turns that model off. Pick an available one, or remove the entry from `CommandCenter.json`. |
| A turn is refused before it starts, naming a model | Same cause, arriving from the API — the model was validated before any worker or billable turn. |
| A checkpoint, history zoom, or handoff action is missing on a Cursor conversation | Expected: checkpoint capture, checkpoint forks, and handoff are declared unavailable for Cursor. |
| A script inside a Cursor conversation cannot find an API token | Expected: credential-shaped environment variables are stripped from Cursor workers. See [Cursor workers inherit no credentials](#cursor-workers-inherit-no-credentials-from-the-server). |
| The conversation shows a "billed cost is unavailable" notice | The account's key cannot reach the provider's usage endpoint. Token counts are still recorded; cost stays unknown rather than estimated. |
| The transcript header shows *Context unknown* | Expected and permanent: the SDK publishes no context-window figures. |
| A queued attachment waited for the next turn | Expected: live steering accepts text only. |
| A queued message is held for review after a cancel or restart | Its delivery acknowledgement was lost after dispatch; Command Center will not resend a message it may already have delivered. |
