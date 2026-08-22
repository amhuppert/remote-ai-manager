# Cursor as a third Command Center backend — research and level of effort

## Verdict

Alex — this is feasible and worth doing, gated on a short spike. The joint level-of-effort verdict:

| Delivery level | Scope | Estimate | Confidence |
| --- | --- | ---: | --- |
| **Decision spike** | Authenticated bake-off: isolated `@cursor/sdk` worker vs ACP child, on the primary platform | **2–4 days** | Medium |
| **Interactive Cursor conversations** | Selectable backend, streaming, continuity, cancellation, auth/preflight, transcripts, config/UI, tests | **~3 weeks cumulative** | Medium |
| **Production scoped backend** | + managed skills, authoritative MCP, images, structured output, usage/cost, nongoverned one-shot tasks, hardening, live verification | **4–6 weeks cumulative, ±30%** | Medium-low until spike |
| **Safety-gated parity** | Privileged instructions, exact write confinement, governed/validator roles, capability cascades | **Vendor-gated, not schedulable**; ~1–2 weeks conditional increment if both gates pass | Low |
| **Collaboration Mode** | Generalizing the intentional Claude×Codex pair | **Separate product project** | Not estimated |

Secondary size signal: **~9,000–13,000 LOC including tests**, calibrated against the Codex adapter (8,966 LOC: 3,313 production / 5,653 test across 28 files, ~1.7× test:prod — a fair floor since Codex is also an SDK-based adapter). One senior engineer familiar with CC assumed; estimates include tests, logging, UI/config, and live verification.

The biggest unknowns are **vendor mechanisms** (a privileged instruction channel, exact filesystem confinement) and **operational shape** (worker isolation, auth UX) — not CC's architecture, which is demonstrably ready for a third backend.

## What the Cursor CLI offers today (researched 2026-08-12)

The CLI installs from `cursor.com/install` as `agent` (legacy alias `cursor-agent`; distinct from the editor's `cursor` command), currently build `2026.08.11-e8db854`, auto-updating with date+hash versions. It is not installed on this machine; findings are from official docs plus one live unauthenticated protocol probe.

Three programmatic surfaces, two of them credible:

1. **`@cursor/sdk`** — first-party TypeScript SDK, verified on npm (v1.0.27, published 2026-08-06, `engines.node >=22.13`). `Agent.create()` / `Agent.resume(agentId)` / `agent.send()` → `Run` with typed event streaming, `wait()`, `cancel()`; durable local checkpoint store that survives process restarts; per-run token usage plus billed-cost queries (`getUsage().cost.chargedCents`); inline MCP servers (stdio + http); in-process custom tools; images; sandbox options; model catalog via `Cursor.models.list()`. Caveats: the agent loop runs **in-process** with native platform binaries, docs state "tool call schema is not stable," and its `Cursor.auth.login()` credential store does not reuse CLI/desktop login state.
2. **ACP** (`agent acp`) — persistent stdio JSON-RPC 2.0 server: `session/new`/`session/load`, `session/prompt`, streamed `session/update`, bidirectional `session/request_permission`, `session/cancel`, plus Cursor extensions (`cursor/ask_question`, `cursor/create_plan`). A live probe of the current binary negotiated ACP v1 and advertised `loadSession: true`, image prompts, and http/sse MCP — with **no** `session/resume`, so continuation replays via `session/load`. Per the ACP v1 spec, stdio MCP is the required baseline transport (the http/sse flags advertise the optional extras). There is an official ACP TypeScript client package.
3. **Print mode** (`agent -p --output-format stream-json`) — last-resort fallback only: failed runs can exit with no terminal JSON, partial streaming duplicates assistant flushes, thinking is suppressed, tool payloads are open-ended, it cannot service permission/question flows, and Cursor's own docs conflict on headless write behavior without `--force`.

Also relevant: Cursor discovers Agent Skills in `.agents/skills/` (and `.cursor/skills/`) anywhere in the repo, including headless — directly compatible with CC's existing Codex managed-skills symlink bridge. Models are account/team-specific with real churn (Composer 2 already retired), and Cursor's guidance is explicitly "discover, don't hard-code." Enterprise admins can disable headless operation, which preflight must detect.

## Why CC's side is the cheap side

The backend seam was built for this, and CI has already answered the core architectural question: a 574-LOC `testfake` **third** backend flows end-to-end through AgentCall, lanes, transcripts, MCP apply, and fork paths in the consumer-locality suite. That proves the *parametric runtime seam* — config, settings UI, commands, persistence codecs, and workflow selection remain real (mostly mechanical) work, since several surfaces still materialize exactly two providers.

Concrete reuse wins: structured output takes Claude's `post_validation` path unchanged (Cursor has no native schema enforcement); managed skills generalize the Codex `.agents/skills` bridge; `child-env` and `session-env`/`cctl` wiring are reused as-is; the conformance harness (792 LOC, behavioral) parameterizes over descriptors; no SQLite migration is needed (backend/ref columns are TEXT — though the session-ref codec and round-trip contract tests need explicit extension).

One early standalone fix regardless of everything else: `src/lib/commands/route-handlers.ts:66-68,115-117` silently maps every non-Codex backend to Claude. That must become schema validation before a third backend id exists, so unknown backends fail loudly instead of receiving Claude commands.

## The plan

### Phase 0 — decision spike (2–4 days, blocking)

Compare **a per-conversation isolated `@cursor/sdk` worker** (Node child owned by CC, env fixed at spawn, thin IPC — an inline SDK loop in the CC server is ineligible, because concurrent conversations need distinct credential-bearing `CC_*` environments and mutating shared `process.env` is unsafe) against **a per-conversation ACP child**. Decision weights, in order: environment isolation and process lifecycle/cleanup; permission semantics; continuity; MCP authority; models; usage/cost; authentication; implementation burden (Bun compatibility is just a packaging check — the worker is a Node child, and CC already guarantees `node` on PATH).

Exit criteria (fixtures + a decision table, not a demo): concurrent `CC_*` isolation proof; full auth matrix (CLI login/key vs SDK key/env/`Cursor.auth.login()` store); lossless native-event fixture capture (byte-level for ACP lines, lossless object serialization for SDK events) to pin the transcript contract test; create → kill → resume/load round-trip with stale-ref behavior; cancellation during generation/shell/permission-wait plus process-tree cleanup; a real stdio MCP server injection plus ambient-config authority; authenticated model catalog query and model-survival-on-resume; instruction-channel check; preliminary write-sandbox verdict; usage/cost settlement timing.

### Phase 1 — interactive Cursor conversations (~3 weeks cumulative)

Conversation facet only. Descriptor + metadata, conversation runtime on the winning transport, `session/load`-or-`Agent.resume` continuity persisted as the opaque `AgentSessionRef`, streaming/tool projection into neutral events with lossless envelopes, cancellation, failure classification, auth/preflight (min-version pin against auto-updates; enterprise-policy detection), minimal default + validated custom-ID model flow, canonical enum/config/codec/catalog/settings work, conformance + consumer-locality registration, seam-baseline regeneration.

Conservative v1 declarations: `post_validation` structured output; synthetic or unsupported fork; next-turn queueing only; no external turns; `fsWriteRestriction: "unsupported"`; conversations at Codex-equivalent instruction fidelity (first-user-turn prepending — the same mechanism Codex conversations use today).

### Phase 2 — production scoped backend (4–6 weeks cumulative, ±30%)

Managed-skills bridge generalization (after a live discovery test), authoritative MCP behavior, images, the async account-model-catalog seam extension, token usage now / billed cost only when settled and correlated (else null — no token-based estimation, since Cursor pricing is plan-based), the task facet **restricted to nongoverned task profiles via an explicit eligibility gate** (governed tasks carry instructions that must not fall back to user-priority text), lifecycle hardening, and live verification. The Codex integration's history (+3,187/−84 first conversation change after a +1,662 task integration, then a long tail of resume/queue/cost/skills/stall fixes) is the calibration for why this phase is weeks, not days.

### Parity — independent vendor gates, not a phase

- **Exact filesystem confinement**: Cursor has sandbox machinery (Seatbelt on macOS, Landlock/seccomp on Linux, allow/readonly paths, `sandbox.json`), but CC's `fsWriteRestriction: "enforced"` is a mechanical security claim requiring an adversarial suite (direct-tool writes, shell writes, symlink escapes, absolute/temp paths, nested processes, deny precedence) to pass per platform. Until then Cursor is excluded from graph-validator and ownership-confined roles. Provable with engineering effort — plausibly during hardening.
- **Privileged instructions**: neither the SDK nor ACP documents a system/developer channel above user priority. This blocks governed task/validator/charter parity until Cursor exposes one — engineering time cannot manufacture it.

If both gates pass, enabling the remaining declarations is roughly 1–2 further weeks. Capability-cascade discovery (a ~800-LOC `cursor-discovery.ts` twin) is deferrable parity work. Collaboration Mode stays the intentional Claude×Codex pair (decision D19); making Cursor eligible there is a product decision, not a registration.

## Key risks

- **Vendor motion**: weekly-ish CLI releases, unstable tool-call schema, model catalog churn. The lossless-envelope design contains this below the seam, but the transcript fixture and event mapping become a maintenance surface; pin a minimum-tested version and feature-negotiate.
- **Auth UX**: the SDK credential store doesn't reuse `agent login`; whichever path wins, CC gets its first explicitly-documented credential lifecycle (today both backends ride ambient auth). Small code, real decision.
- **Billing**: all Cursor inference routes through Cursor's cloud on the account's plan; cost may settle asynchronously.
- **Enterprise policy**: admins can disable headless agents — preflight must fail clearly.

## Recommendation

Proceed. Run the 2–4 day authenticated spike first — it selects the transport and settles the highest-leverage unknowns. Ship interactive Cursor conversations (~3 weeks), then the scoped production backend (4–6 weeks cumulative). Treat parity as gates to verify, not a phase to schedule, and keep Collaboration Mode out of scope. Cursor's surface (first-party SDK, ACP with bidirectional permissions, durable sessions, native `.agents/skills` support) makes it the easiest plausible third backend — materially easier than Codex was, because the seam, structured-output, managed-skills, and env patterns all now exist to copy.

## Sources

- Cursor docs: [CLI overview](https://cursor.com/docs/cli/overview), [headless](https://cursor.com/docs/cli/headless), [parameters](https://cursor.com/docs/cli/reference/parameters), [output formats](https://cursor.com/docs/cli/reference/output-format), [authentication](https://cursor.com/docs/cli/reference/authentication), [permissions](https://cursor.com/docs/cli/reference/permissions), [configuration](https://cursor.com/docs/cli/reference/configuration), [changelog](https://cursor.com/docs/cli/changelog), [ACP](https://cursor.com/docs/cli/acp), [TypeScript SDK](https://cursor.com/docs/sdk/typescript), [SDK bridge](https://cursor.com/docs/sdk/bridge), [sandbox](https://cursor.com/docs/reference/sandbox), [Agent Skills](https://cursor.com/docs/skills)
- ACP spec: [v1 session setup](https://agentclientprotocol.com/protocol/v1/session-setup), [v1 schema](https://agentclientprotocol.com/protocol/v1/schema), [TypeScript library](https://agentclientprotocol.com/libraries/typescript)
- npm registry: `@cursor/sdk` v1.0.27 metadata
- Repository: `src/lib/agent-backends/` (descriptor/conversation/task/continuity/conformance, `codex/` and `claude/` adapters), `.kiro/steering/agent-backends.md`, `scripts/seam-baselines.json`, config/catalog/settings/commands paths cited above, Codex integration git history, `docs/reports/2026-06-21_competitive-landscape-and-feature-opportunities.md`
