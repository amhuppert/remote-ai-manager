# Cursor as a third Command Center backend — research and level of effort

**Verdict: Medium-to-large, well-bounded — roughly comparable to (likely slightly smaller than) the Codex integration.** Cursor now ships a first-party TypeScript SDK (`@cursor/sdk`) that maps cleanly onto CC's backend seam, the seam itself was deliberately built to accept a third backend (a fully-implemented `testfake` third backend already flows through the entire consumer corpus), and Cursor's Agent Skills support uses the same `.agents/skills/` convention CC's Codex managed-skills bridge already targets. Estimated total: **~9,000–13,000 LOC including tests**, phased as a 2–4 day spike, a ~2–3 week v1, and an optional ~1–2 week parity pass. The biggest unknowns are environmental (Bun compatibility of the SDK, API-key auth) rather than architectural.

---

## 1. What the Cursor CLI/platform offers today (Aug 2026)

The CLI installs via `cursor.com/install` and invokes as `agent` (formerly `cursor-agent`). It is not installed on this machine; everything below is from Cursor's current docs.

### Four programmatic integration surfaces

| Surface | Shape | Fit for CC |
|---|---|---|
| **`@cursor/sdk` (TypeScript)** | First-party SDK, Node ≥22.13. `Agent.create()` / `Agent.resume(agentId)` / `agent.send()` → `Run` with `stream()` (typed `SDKMessage` events), `wait()`, `cancel()`, `conversation()`. Runs the agent loop **in-process** (not a CLI wrapper); ships platform binaries for sandboxing/ripgrep; all model inference routes through Cursor's cloud. | **Primary candidate.** Same integration class as `@openai/codex-sdk`, which is why the Codex adapter is only ~3.3k prod LOC. |
| **ACP (`agent acp`)** | Stdio JSON-RPC 2.0: `session/new`, `session/load`, `session/prompt`, streamed `session/update`, `session/request_permission`, `session/cancel`; extension methods incl. `cursor/ask_question`. | **Fallback #1** — process-isolated, protocol-documented; the right escape hatch if the SDK won't run under Bun. |
| **Headless CLI** (`agent -p --output-format stream-json`) | NDJSON events: `system/init`, `user`, `assistant`, `tool_call` (started/completed), `result` — `session_id` on every event; `--resume <chatId>` for continuity; `--force` to apply changes non-interactively. **No token usage in the stream.** | Fallback #2 — this is the raw-transport path; CC would own line framing, process lifecycle, exit-code mapping. |
| **SDK bridge** (`cursor-sdk-bridge`) | Connect/protobuf wrapper of the TS SDK for non-TS languages. | Not needed. |

### Capabilities that matter for a backend adapter

- **Continuity is real and durable.** `Agent.resume(agentId)`; local agents persist a checkpoint store (SQLite/JSONL) that survives process restarts; CLI equivalent `--resume <chatId>` / `agent ls` / `create-chat`. Multi-turn context loads automatically on each `send()`. This matches Codex's per-turn re-materialization + persisted-thread-id model almost exactly.
- **Token usage and *billed* cost.** `RunResult.usage` (input/output/total tokens) per run, and `agent.getUsage()` returns historical runs + `cost.chargedCents`. Per-run (not lineage-cumulative) usage means the Codex `cost-baseline.ts` delta machinery is unnecessary — and unlike Codex's estimated pricing, Cursor reports actual billed cost.
- **MCP:** inline `mcpServers` (stdio and http) at `Agent.create`, plus file config (`.cursor/mcp.json`, `~/.cursor/mcp.json`); in-process `customTools` (function + JSON Schema, no server needed); CLI `mcp list / list-tools / enable / disable` subcommands and `--approve-mcps`.
- **Agent Skills, including headless.** Cursor discovers skills in `.cursor/skills/` **and `.agents/skills/`** anywhere in the repo (nested = directory-scoped), `~/.cursor/skills/` for user scope; changelog confirms skills load in interactive, headless, and editor-integration modes (May 2026) and that managed skills can ship Markdown resources (Aug 2026). Cursor also supports rules, AGENTS.md, plugins (marketplace + `--plugin-dir`), hooks, and file-based subagents (`.cursor/agents/*.md`).
- **Permissions/sandbox:** SDK `tools` allowlist / `disallowedTools`, `sandboxOptions {enabled}`, `autoReview` (classify each call allow/sandbox/ask); `.cursor/sandbox.json` network allowlists; CLI `--sandbox enabled|disabled`, `sandbox run --allow-paths --readonly-paths --blocked-patterns`, `permissions.json` allowlists, `--force`/`--yolo`. Headless CLI without `--force` only *proposes* changes.
- **Models:** `Cursor.models.list()`; per-model `params` (e.g. `fast`, reasoning options) instead of a fixed effort ladder; `auto-smart` router with `optimize_for: cost|balanced|intelligence`; model shortcuts and a catalog that auto-refreshes. Catalog churn is real (Composer 2 already retired with automatic rerouting to 2.5).
- **Other:** image input on `send()` (base64 + mime type), plan/ask/agent modes, native worktree support (`-w`), cloud runtime + self-hosted workers (out of scope for CC).
- **Auth:** `agent login` (stored local credentials) or `CURSOR_API_KEY` / `--api-key`; the SDK examples all pass `apiKey`. Docs recommend API keys for headless/CI use. All usage bills through the Cursor plan.

### Stability caveats

- Docs state **"tool call schema is not stable"** — `args`/`result` payloads can change as tools evolve.
- The stream formats carry no token usage (SDK does); no explicit stability guarantee is published for the SDK, though it is clearly the promoted path ("Lead with TypeScript or Python").
- The product moves fast (weekly-ish CLI changelog entries through Aug 11, 2026).

## 2. What CC requires of a third backend (grounded in the actual seam)

From a full sweep of the current worktree:

- **The contract:** `AgentBackendDescriptor = { id, metadata, conversation?, tasks?, managedSkills, mcp, errors }` (`src/lib/agent-backends/descriptor.ts`), with closed capability vocabularies (`continuationStrength`, `fork`, `structuredOutput`, `queue`, `capabilityKinds`, `fsWriteRestriction`) — all **behaviorally verified** by the 792-LOC parameterized conformance harness (`conformance.ts`), not shape-checked.
- **The proxy cost:** the Codex adapter is **8,966 LOC across 28 files** — 3,313 production + 5,653 test (~1.7× test:prod). Crucially, Codex is an *SDK-based* adapter: `thread.runStreamed()` hands it a typed async generator, so it never parses NDJSON or manages a child process. The Claude adapter (16,352 LOC) is bigger because it owns a long-lived query session, background-task tracking, and content-block mapping.
- **The seam genuinely holds.** `agentBackendSchema = z.enum(["claude","codex"])` in `src/lib/shared/schemas.ts:7` is the single canonical enum; the ~145 out-of-seam production files that mention a backend are overwhelmingly catalog-driven UI (no per-backend edits), config/persistence mechanics, and a reviewed 23-count identity-branch ratchet (`seam-baselines.json`, enforced both directions). A 574-LOC `testfake` **third** backend already runs end-to-end through AgentCall, lanes, transcripts, MCP apply, and fork paths in `consumer-locality.test.ts` — the "does the seam accept a third backend?" question has effectively already been answered in CI.
- **Known intentional walls:** the capability-cascade taxonomy (`AGENT_CAPABILITY_CASCADE_KINDS` in `src/lib/agent-capabilities/schemas.ts`) is the designed rejection point for third-backend capability discovery (a `cursor-discovery.ts` twin of the 803-LOC `codex-discovery.ts` is the parity cost); Collaboration Mode is **structurally two-backend** (`workflows/collaboration/backend-pair.ts`, decision D19); a backend with `fsWriteRestriction: "unsupported"` is **refused as a graph-workflow validator**.
- **No prior Cursor work exists** in code, specs, or memory-bank. The only prior art is the June 2026 competitive-landscape report flagging Cursor backend support as high value.

## 3. Capability mapping: Cursor → CC descriptor

| Descriptor requirement | Cursor answer (SDK path) | Confidence |
|---|---|---|
| Execution transport | `@cursor/sdk`, per-conversation `Agent` + per-turn `send()` → typed event stream; same shape as Codex's per-turn re-materialization | High (docs); **Bun compat unverified** |
| `continuationStrength` | `"precise_session"` — persisted agent id, `Agent.resume()`, durable checkpoint store | High |
| `fork` | No SDK fork documented (CLI `/fork` is interactive-only) → `"synthetic"` via CC's existing `syntheticForkSeed`, or `"unsupported"` in v1 | Medium |
| `structuredOutput` | No native JSON-schema output enforcement → **`"post_validation"`**, reusing Claude's prompt-contract renderer + the shared extractor + bounded repair, unchanged | High |
| Cost / context metrics | `usage` tokens per run + `getUsage().cost.chargedCents` (real billed cost; no Codex-style cumulative-baseline needed). Context-window max not documented → likely `contextWindowMetrics: false` | High / Medium |
| `managedSkills` | `"bundled"` — Cursor natively discovers `.agents/skills/`, so the Codex symlink bridge (`codex/managed-skills-bridge.ts`, 234 LOC) generalizes almost verbatim; possibly shareable rather than duplicated | High |
| `mcp` facet | Inline `mcpServers` translation from `PortableMcpConfig` is easy; **whether inline config suppresses `.cursor/mcp.json`/user servers is unknown** → `strictAuthoritativeConfig: false` in v1 (CLI `mcp disable` exists but mutates shared user config, which CC's live-state rules forbid) | Medium |
| `fsWriteRestriction` | Sandbox exists (SDK `sandboxOptions`, CLI `--allow-paths`/`--readonly-paths`, `.cursor/sandbox.json`), but writable-root confinement equivalent to Codex `workspace-write` is **unverified** → spike; if absent, `"unsupported"` and Cursor can't serve as a graph-workflow validator | Medium |
| Queue | Undocumented mid-run `send()` semantics → declare `acceptsWhileRunning: false`, `next_turn` delivery (CC-side queue) | Conservative |
| `errors` classifier | Shared machinery (`createClassifierWithDefaultContinuation`) + a Cursor stale-resume marker; like Codex, per-turn materialization means no `session_died` | High |
| Models / effort | Static CC catalog entries for Composer 2.5 / auto-smart / frontier models; CC `reasoningEffort` maps onto Cursor per-model `params` — a design decision, and the `codexFastMode` leaked field suggests generalizing a "speed/params" channel instead of adding `cursorFastMode` | Medium |
| Auth | **Design decision:** SDK path wants `CURSOR_API_KEY` (breaks CC's current all-ambient-auth pattern — zero API keys in `src/lib` today); CLI/ACP paths can ride `agent login` stored credentials | High facts; decision needed |
| Images / capabilityKinds / mid-turn ask | Images: yes (base64). Capability cascade (cursor-skills/plugins discovery): defer to parity phase or declare none. Mid-turn ask: `false` (cctl covers it; ACP's `cursor/ask_question` exists if ever wanted) | High / Medium |

## 4. Level of effort

### Phase 0 — Spike (2–4 days, blocking)

Install the CLI + SDK and answer, in order of estimate-moving power:

1. **Does `@cursor/sdk` run under Bun?** (Node ≥22.13 requirement, in-process agent loop, platform binaries.) If not: Node child-process shim, or the ACP transport (adds ~500–800 LOC of JSON-RPC client but stays process-isolated), or headless-CLI stream-json (adds the full ~800–1,500 LOC transport layer the Codex adapter never needed — worst case).
2. **Resume durability in practice** — create → send → kill process → `Agent.resume` → send in a CC-like worktree; confirm the stale-ref failure mode and message shape.
3. **Write confinement** — can `sandboxOptions` (or equivalent) confine writes to an allowlisted root? Decides `fsWriteRestriction` and validator eligibility.
4. **Headless permission semantics** — that SDK-local agents execute tools without a TTY under a tools-allowlist, no interactive gate.
5. **MCP config authority** — does inline `mcpServers` mask file-based/user servers?
6. **Capture real event streams** to pin the transcript contract fixture (Cursor analogue of Claude's 314-LOC `transcript-frames.contract.test.ts`).
7. **Auth** — whether the SDK honors stored `agent login` credentials or strictly requires an API key; where the key lives in CC config if required.

### Phase 1 — v1 backend (~2–3 weeks; ~4,500–6,500 LOC incl. tests)

Descriptor + metadata + model schemas; conversation runtime and task runner on the SDK (Codex adapter as the template, minus cost-baseline, minus NDJSON, plus SDKMessage→content-block mapping); continuity adapter; failure classifier; transcript projections + new byte-level contract test; structured output as `post_validation` (pure reuse); managed-skills bridge generalized from Codex's; portable-MCP translation (non-strict); canonical enum + config schema + session-ref codec + migration touches (~200 LOC, mechanical); catalog/UI entries (tone token, `BackendsSection`; pickers are catalog-driven); conformance + consumer-locality registration; seam-baseline regeneration; steering-doc updates.

v1 capability declarations: no fork (or synthetic), no capability cascade kinds, `strictAuthoritativeConfig: false`, `fsWriteRestriction` per spike outcome.

### Phase 2 — Parity (optional, +1–2 weeks; ~3,000–4,000 LOC)

`cursor-discovery.ts` capability-cascade provider (skills/plugins; the Codex twin is 803 LOC) + taxonomy entries + codec; fs-write enforcement (validator eligibility) if the spike says yes; MCP strictness/native-suppression if feasible without mutating user config; model-params surface (generalize the fast-mode channel); polish.

### Explicitly out of scope

Collaboration Mode inclusion (structurally 2-backend by decision D19 — reopening it is its own design conversation), Cursor cloud agents / workers, hooks/plugins passthrough.

## 5. Risks

- **Bun compatibility of the SDK** — the single biggest swing factor (±1–2 weeks across the fallback ladder). Everything else about the estimate is stable across transports.
- **Wire/schema churn** — "tool call schema is not stable" + fast-moving catalog. CC's lossless-envelope design contains this below the seam, but the transcript contract fixture and content-block mapping become a maintenance surface with no vendor type package to catch drift at compile time (the SDK does ship `.d.ts`, which helps if the SDK path works).
- **Auth model divergence** — first backend needing an explicit API key in CC config; small code, real decision.
- **Billing** — Cursor routes all inference through its cloud on the user's Cursor plan; worth stating in docs so cost expectations are set.

## 6. Recommendation

Proceed, gated on the Phase 0 spike. The seam was built for exactly this and has already been proven against a synthetic third backend; Cursor's SDK, durable resume, per-run usage/billed cost, `.agents/skills/` support, and sandbox make it the *easiest* plausible third backend — materially easier than Codex was, since the transport, structured-output, managed-skills, and env patterns all exist to copy. The spike's Bun-compatibility answer should be in hand before committing to a schedule, because it selects the transport and moves the estimate more than any other single fact.

---

## Sources

- [Cursor CLI overview](https://cursor.com/docs/cli/overview.md) · [Headless usage](https://cursor.com/docs/cli/headless.md) · [Parameters reference](https://cursor.com/docs/cli/reference/parameters.md) · [Output formats](https://cursor.com/docs/cli/reference/output-format.md) · [Authentication](https://cursor.com/docs/cli/reference/authentication.md) · [CLI changelog](https://cursor.com/docs/cli/changelog.md) · [ACP](https://cursor.com/docs/cli/acp.md)
- [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript.md) · [SDK bridge](https://cursor.com/docs/sdk/bridge.md)
- [Agent Skills docs](https://cursor.com/docs/skills) · [Skills help](https://cursor.com/help/customization/skills) · [Cursor 2.4 changelog (subagents/skills)](https://cursor.com/changelog/2-4)
- Codebase: `src/lib/agent-backends/` (descriptor/conversation/task/continuity/conformance), `codex/` adapter, `.kiro/steering/agent-backends.md`, `scripts/seam-baselines.json`, `docs/reports/2026-06-21_competitive-landscape-and-feature-opportunities.md`
