# Cursor Backend

Command Center runs Cursor as a third agent backend alongside Claude and Codex. Phase 1 delivers **conversations only**: you can pick Cursor in any conversation composer, and it streams, persists, resumes, and cancels the same way the other backends do.

Later phases added tasks, workflow roles, and Collaboration Mode. Where a surface still cannot run Cursor, the UI says so on the option rather than hiding it. See [Unsupported in Phase 1](#unsupported-in-phase-1) and [Collaboration Mode](#collaboration-mode).

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
| `@cursor/sdk` | **1.0.28** exactly — no range |
| The host's platform package | **1.0.28**, matching the SDK version |

Machine eligibility follows the SDK installation, not an acceptance-evidence allowlist. Command Center derives the platform package from Node's `process.platform` and `process.arch`; for example, Apple Silicon uses `@cursor/sdk-darwin-arm64`. The pinned SDK currently publishes these packages:

| Host | Platform package |
| --- | --- |
| macOS Apple Silicon (`darwin-arm64`) | `@cursor/sdk-darwin-arm64` |
| macOS x86_64 (`darwin-x64`) | `@cursor/sdk-darwin-x64` |
| Linux ARM64 (`linux-arm64`) | `@cursor/sdk-linux-arm64` |
| Linux x86_64 (`linux-x64`) | `@cursor/sdk-linux-x64` |
| Windows x86_64 (`win32-x64`) | `@cursor/sdk-win32-x64` |

Before a worker starts, Command Center verifies that the SDK's Node entry points, its lazily-loaded chunks, its declared dependencies, the derived platform package, and that package's executable native assets (ripgrep, the sandbox helper, the tree-sitter bindings, with their execute bits intact) are all present. A missing or mismatched artifact or a Node version below the floor produces a bounded error that names the mismatch — Cursor is simply unavailable on that machine, and nothing auto-updates or silently substitutes a different build.

The SDK and platform-package version pins remain strict so their package layouts and runtime contracts stay aligned.

Deployments that ship Command Center must package these dependencies rather than expect a runtime install.

---

## Models

The default model is **`composer-2.5`**, chosen explicitly on every run. Command Center never relies on Cursor's own auto-selection, and it never substitutes a different model for one you asked for.

Which models a project's Cursor conversations may run is a **per-project setting** in that project's `CommandCenter.json`:

```json
{
  "agentBackends": {
    "cursor": { "supportedModels": ["composer-2.5"] }
  }
}
```

Omit the block and the effective list is `["composer-2.5"]`. The complete selection for a turn resolves atomically: the selection chosen for the conversation → the global `agentBackends.cursor.modelSelection` → the generated catalog's default variant for `composer-2.5`. Its model must be a member of the project's list, or the turn is refused with a client error **before any Cursor process starts**. A declared-empty list permits nothing. See [Project Configuration → `agentBackends.cursor`](./project-configuration.md#agentbackendscursor--cursor-supported-models) for the full rules.

Command Center renders every user-selectable parameter advertised for the chosen model. Effort or reasoning appears beside the model picker; thinking, context size, fast mode, and future multi-value parameters appear under Model Options. Fixed parameters remain hidden in the UI but stay in the exact selection sent to Cursor.

Two consequences worth knowing:

- **The parameter catalog is generated, not discovered per request.** `bun run cursor-models:refresh` calls the authenticated `Cursor.models.list()` API and writes a checked-in catalog. Normal builds run `cursor-models:check` without a credential or network call. `CommandCenter.json` still controls the project's model-ID allowlist.
- **A model the SDK itself rejects** (an id in your list that Cursor does not actually serve) fails the turn with a bounded model-configuration error. It never falls back to `composer-2.5`, so a stale entry surfaces as an error rather than as an answer from a model you did not ask for.

The composers offer exactly the project's list. A globally configured model outside it is shown as an explicit invalid selection, in red, waiting for you to choose — not quietly replaced.

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

## Tokens and cost

Every finished Cursor turn reports **at most one** usage record, carrying the SDK's input, output, cache-read, cache-write, and total token counts, plus reasoning tokens when Cursor reports them. Following the SDK's own convention, the total **excludes** reasoning tokens.

**`costUsd` is always `null` for Cursor.** Cursor's pricing is plan-based, and its billed-usage API reports the per-turn figure as unavailable, so there is no settled charge Command Center can attribute to a turn. Nothing estimates a dollar figure from token counts, model names, or published rates — an honest null is preferred to a fabricated number. Cost columns and totals for Cursor conversations will therefore read as unavailable rather than zero.

Cancelled, failed, and retried turns report **no** usage at all rather than a partial or fabricated count, and usage is never carried across turns.

---

## Tools and permissions

Phase 1 runs a fixed, non-interactive **bypass policy**. It is Command Center code policy, not a setting: there is no user-facing tool-configuration surface for Cursor.

- **Sandboxing is off** (`sandboxOptions.enabled: false`) and **auto-review is off**.
- **Ambient Cursor settings are not loaded.** The worker attaches with empty setting sources, so user, project, and MDM Cursor settings on the host cannot change what a Command Center run does. Command Center never reads or writes your Cursor configuration.
- **The two interactive tools — `askQuestion` and `await` — are denied**, because Command Center has no mid-turn approval UI for Cursor. Everything else in the default toolset stays available: shell, file operations, search, subagents via `task`, and MCP tools under the usual enable/disable cascade.
- **The interactive denial is main-loop scope only.** Per the SDK's documented semantics, a subagent launched through `task` keeps its own platform-curated toolset, and Command Center makes no claim about tool denial inside one. Subagents remain available and useful; the deny list is main-loop policy, not a complete-toolset guarantee. If a subagent surfaces an interactive request anyway, nothing waits on it — no approval handler is registered — so the turn ends as a bounded failure through the ordinary stall and timeout bounds rather than hanging.
- Because sandboxing is off, **successful tool execution proves nothing about confinement.** Command Center claims no filesystem-write restriction and no network confinement for Cursor, which is also why Cursor is refused by the workflow validator role's write-restriction gate.

### MCP

Inline **stdio** MCP servers work: Command Center passes the server's command, arguments, and environment explicitly to the worker, and reapplies the same configuration on resume. HTTP and SSE MCP transports are not supported for Cursor, and per-tool allow/deny filtering is not supported on any transport — a server carrying a tool filter is refused rather than passed through unfiltered.

Strict MCP authority is **not** claimed. The ordinary inline call path is proven; the authority questions (ambient merge, duplicate names, per-run replacement, disable/filter, permission, environment) are a separate gate that has not been run.

### Skills and slash commands

**Cursor conversations run without Command Center's bundled skills.** The Cursor SDK exposes no command or skill surface, so command discovery for a Cursor conversation returns an empty result — it does not scan `.claude/` or `.codex/` directories and does not invent entries. The slash-command popup will be empty in a Cursor conversation.

---

## Conversation lifetime and cancellation

Each active Cursor conversation runs in exactly one supervised Node worker process of its own, with its own working directory, process group, agent store, and identity. Two conversations never share a worker or observe each other's state.

- **Stop** cancels natively, waits for the agent and worker to tear down, escalates to the worker's own (ownership-verified) process group if the wait is exceeded, and only then reports the conversation closed. Deleting a session waits for that teardown before removing the worktree the worker is using.
- A worker whose Command Center server dies — even by `SIGKILL`, with no orderly shutdown — **terminates itself and its process group** within a bounded interval. There is no orphan sweeper to depend on.
- An idle worker is reaped after **5 minutes** of inactivity. Resuming the conversation simply starts a fresh worker from the persisted session reference.
- A turn that goes quiet for **20 minutes** settles as a bounded stall failure rather than holding the conversation open.

Continuation is durable: the session reference is persisted the moment Cursor issues it, mid-turn, so a server restart or a killed worker does not lose the conversation. The next prompt resumes it in a new worker with the model, tool policy, MCP configuration, and permission policy all reapplied. A reference that is genuinely invalid (deleted, corrupt, or belonging to another workspace) fails closed with a clear classification and is cleared; a merely transient failure — a rate limit, a network blip, a locally killed worker — keeps the reference so the conversation stays resumable.

---

## Unsupported in Phase 1

Command Center declares these unsupported for Cursor in the backend descriptor, the catalog the UI reads, and the UI itself. Where a surface requires one, Cursor appears as a **visibly disabled option with the reason**, and the corresponding API refuses `backend=cursor` with a bounded client error naming the unsupported facet — it never falls back to another backend or leaves partial state behind.

| Not supported | What that means |
| --- | --- |
| **Task facet** | No Cursor agent runs. Task creation, workflow role assignment (including validator roles), and the naming/compaction/workflow-agent backend pickers show Cursor disabled. |
| **Native mid-turn ask** | No approval or question prompt is awaited or surfaced. |
| **Filesystem write restriction** | Not claimed and not enforced; the run is unsandboxed. |
| **Network confinement** | Not claimed and not enforced. |
| **Strict MCP authority** | The ordinary inline stdio path works; authority does not follow from it. |
| **Managed skills** | Command Center's bundled skills are not delivered into Cursor conversations. |
| **Native fork** | Conversations cannot be forked. Resume and reference copying are not fork and are never presented as it. |
| **External turns** | Cursor produces no turns Command Center did not start. |
| **Context-window metrics** | The SDK surfaces no context-window figures, so none are shown. |
| **Mid-turn prompt injection** | A prompt submitted during an active turn is queued and starts as the **next** turn, in order. |
| **Cost reporting** | See [Tokens and cost](#tokens-and-cost) — `costUsd` is always null. |
| **Claude/Codex parity** | Not claimed. Cursor is a conversation backend with the limits on this page. |

Structured output works through the same shared post-validation path every backend uses, including its single bounded repair attempt.

## Collaboration Mode

Cursor participates in Collaboration Mode in either position: a Cursor conversation can start `/collab`, and Cursor can be picked as the second agent of any Claude, Codex, or Cursor conversation. Graph-workflow collaboration accepts Cursor as `secondAgent`; Agent One then runs Cursor's default partner, Claude. The supported pairs are listed explicitly in `src/lib/workflows/collaboration/backend-pair.ts`.

A Cursor lane runs as a Cursor task in the session worktree with the same autonomous settings every collaboration task lane gets. What differs is what Cursor can enforce:

| Aspect | What a Cursor lane does |
| --- | --- |
| **Continuity** | Agent One resumes the originating Cursor conversation's agent when the run grants it the session's CC scope (standalone `/collab`); every later phase resumes the lane's own task ref. Graph-workflow lanes start fresh. |
| **Sandbox, approvals, web search** | Delivered as instructions, not enforced; the run logs `cursor.task_policy_instruction_only`. The `/collab` row shows Cursor's execution warnings next to the second-agent picker. |
| **Cost** | Token usage is attributed to the Cursor lane; `costUsd` stays unknown rather than estimated. |
| **Structured output** | The shared prose-then-format flow and post-validation gate, as for Codex. |

---

## Verifying a deployment

The authenticated live matrix runs through its wrapper, which is not part of the registered validation commands (they are pinned by `src/lib/projects/repo-config.test.ts`):

```bash
bash scripts/validate/cursor-acceptance.sh
```

It exercises the real SDK against a real account on the machine where it runs: preflight taxonomy, two-conversation isolation, streaming and file operations, continuation and invalid-reference handling, model selection, inline MCP, generation/shell/MCP cancellation with host process scans, worker lifetime bounds, image input, usage, and a closing credential sweep. Its evidence is diagnostic and does not admit or deny machines in production.

Without `CURSOR_API_KEY` it exits **78** and reports `verdict=blocked reason=credential_absent` — deliberately neither pass nor fail, so a blocked run can never be mistaken for green evidence. It is not part of any merge gate, because a merge gate must not depend on a credential.

The observed results and the explicit limits of that evidence are recorded in [`docs/plans/command-center-59-cursor-backend/PHASE1_ACCEPTANCE_EVIDENCE.md`](./plans/command-center-59-cursor-backend/PHASE1_ACCEPTANCE_EVIDENCE.md).

---

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Every Cursor turn fails immediately with a credential error | `CURSOR_API_KEY` is absent, empty, or rejected in the **server's** environment. A logged-in Cursor CLI does not count. Restart the server after setting it. |
| Cursor turns fail with a runtime/platform error | The worker's Node is below 22.13, or `@cursor/sdk` / the derived `@cursor/sdk-${platform}-${arch}` package at 1.0.28 is missing, mismatched, or incompletely extracted. |
| The model selector shows a model in red | The configured model is not in this project's `agentBackends.cursor.supportedModels`. Pick a listed one or add it to `CommandCenter.json`. |
| A turn is refused before it starts, naming a model | Same cause, arriving from the API — the model was validated before any worker or billable turn. |
| Cursor is greyed out in a picker | That surface needs a facet Cursor's catalog entry does not register; hover the option for the reason. |
| The slash-command popup is empty | Expected: Cursor has no command or skill surface. |
| A script inside a Cursor conversation cannot find an API token | Expected: credential-shaped environment variables are stripped from Cursor workers. See [Cursor workers inherit no credentials](#cursor-workers-inherit-no-credentials-from-the-server). |
| Cost shows as unavailable | Expected and permanent for Phase 1. Token counts are reported; cost is not. |
