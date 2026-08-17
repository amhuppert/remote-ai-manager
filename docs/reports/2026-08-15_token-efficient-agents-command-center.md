# Token-Efficient Agents Without Sacrificing Quality

**A research and design report for Command Center**  
**Date:** 2026-08-15  
**Status:** Recommendations only; not an approved implementation plan  
**Companion:** [Formatted HTML edition](2026-08-15_token-efficient-agents-command-center.html)

---

## Executive summary

Token efficiency should mean **less total provider cost and less context consumed per successful task**, not merely shorter-looking responses. That distinction changes the order in which Command Center should pursue optimizations.

The strongest opportunities remove or avoid low-value tokens while preserving the agent's ability to retrieve exact evidence. They also put deterministic work in Command Center rather than asking a model to remember budgets, parse logs, track retries, or decide when mechanical checks have passed.

The recommended order is:

1. **Measure the full trajectory.** Preserve cached, uncached, output, reasoning, cost, latency, tool-call, retry, and outcome data for ordinary conversations as well as task runs.
2. **Finish existing progressive-disclosure patterns.** Generalize bounded output, stable handles, explicit omission metadata, and spill-to-file receipts across `cctl`.
3. **Make execution budgets explicit while keeping enforcement deterministic.** Give agents acceptance criteria, scope, remaining budget, and a stop condition; keep retry counts, validation, and halting in the orchestrator.
4. **Reduce persistent prompt and tool surface.** Inventory prompt segments, trim duplicated always-on guidance, and deliberately enable provider-native lazy tool loading where it proves reliable.
5. **Pilot provider-aware cache improvements.** Command Center can improve prefix stability and cache telemetry, but the provider adapters—not a generic cross-provider abstraction—must own cache controls.
6. **Pilot projected context at safe boundaries.** Use compactions, intact transcript units, and auditable supersession when starting a fresh context. Do not pretend Command Center can delete tokens from an opaque provider thread already in progress.
7. **Add routing only after the measurements exist.** Begin with deterministic escalation tiers at task or lane boundaries, not an LLM router making an extra paid call.
8. **Do not build a general lexical prompt compressor.** Query-aware selection of intact chunks is useful; deleting words from policies, code, errors, commands, schemas, or active agent state is not.

### Recommendation matrix

| Approach | Command Center fit | Priority | Primary benefit | Main quality risk | Recommendation |
|---|---|---:|---|---|---|
| Exact-prefix prompt caching | Strong, but provider-mediated | P1 | Lower cost and time-to-first-token | Low; cache invalidation is operational rather than semantic | Instrument conversations, stabilize prefixes, then run adapter-specific experiments |
| Lean prompts and tool catalogs | Very strong | P1 | Lower recurring input and better signal-to-noise | Discovery misses if too much becomes hidden | Add prompt accounting; trim duplication; use provider-native lazy tools |
| Stale-observation masking | Strong at context boundaries | P2 | Lower input/context load on long trajectories | Summary drift or removal of still-relevant evidence | Extend compaction and transcript projection conservatively; preserve exact recovery handles |
| Progressive, recoverable tool output | Very strong; existing precedent | P1 | Large reduction in tool-result context | Silent omission or unstable handles | Generalize bounded output and content-addressed spill receipts across `cctl` |
| Bounded success and stop conditions | Very strong; aligned with current architecture | P1 | Fewer unnecessary turns, edits, and validations | Premature stopping if acceptance criteria are weak | Inject a compact execution contract; keep all enforcement in code |
| Adaptive model and effort routing | Useful but conditional | P3 | Lower dollar cost for easy work | Bad routing creates rework and can break continuity | Start with auditable deterministic escalation tiers after telemetry exists |
| Lexical or lossy compression | Poor as a general platform feature | P4 / reject broadly | Smaller long natural-language context | Dropped constraints, identifiers, negations, or ordering | Build intact-chunk retrieval instead; allow lossy derivatives only as explicit, recoverable aids |

## Decision lens

Every proposal in this report is evaluated against five outcomes:

- **Task quality:** deterministic validation, semantic review, scope control, and operator comprehension.
- **Total trajectory usage:** every input, cache write/read, output, reasoning token, tool call, retry, summarizer, router, validator, and sub-agent call.
- **Cost per successful task:** not cost per request and not compression ratio.
- **Latency:** including preprocessing, cache misses, routing, retrieval, and extra round trips.
- **Recoverability:** omitted information remains addressable by a stable handle and exact follow-up action.

Two distinctions stay important throughout:

1. **Caching saves money and latency but does not shrink the logical context window.** Cached tokens still enter the model.
2. **Removing irrelevant context can improve reasoning; compressing task-defining instructions can damage it.** The content being removed matters more than the raw percentage.

---

## 1. Exact-prefix prompt caching

### General approach

Prompt caching reuses computation for an identical leading sequence of tokens. Static system instructions, tool schemas, examples, and other common material are placed first; request-specific and time-varying material comes later. When the provider recognizes the prefix, it charges cached input at a lower rate and often reduces time-to-first-token.

This is the cleanest economic optimization because the model receives the same logical content. Output generation does not need to change, and the approach does not impose a smaller reasoning budget. The [OpenAI prompt-caching guide](https://developers.openai.com/api/docs/guides/prompt-caching) explicitly recommends stable prefixes and static-first ordering. A multi-provider agent study, [Don't Break the Cache](https://arxiv.org/abs/2601.06007), reported substantial cost and latency reductions from disciplined cache boundaries, though exact results depend on provider, workload, and cache policy.

Caching has limits:

- It does not make the context window smaller.
- A timestamp, reordered tool, regenerated system block, or compaction near the front can invalidate everything after it.
- First-call cache writes can cost more than uncached input.
- Provider APIs expose different controls and usage fields.
- Subscription quotas may not track cached-token economics the same way as API billing.

### Command Center assessment

**Fit: strong, with provider-specific implementation.** Command Center already creates session instructions once per backend runtime and generally keeps them stable during that runtime. Claude uses a long-lived SDK query session, while Codex starts or resumes a persistent thread. That is a favorable baseline.

The immediate problem is observability. Task runs already normalize cached-input usage through `AgentTaskResult` and `AgentCallUsageMetrics`, but ordinary conversation turns discard most input/output/cache counts even though the provider runtimes receive them. Conversation state has nullable slots for those values, so the missing link is largely in adapter result mapping and the normalized conversation result.

Relevant seams include:

- `src/lib/workflows/conversation/actor-implementations.ts` — assembles session instructions and creates runtimes.
- `src/lib/agent-backends/claude/query-session.ts` and `conversation-runtime.ts` — Claude session options, result accounting, and cumulative cost handling.
- `src/lib/agent-backends/codex/conversation-runtime.ts` — Codex thread lifecycle and usage deltas.
- `src/lib/agent-backends/conversation.ts` — normalized conversation turn result.
- `src/lib/workflows/primitives/agent-call-conversation.ts` — conversion to shared usage metrics.
- `src/lib/workflows/conversation/types.ts` — existing persisted usage slots.

The installed Claude Agent SDK also exposes an option that moves dynamic preset sections out of the system prefix to improve cacheability across users. That is worth an adapter-level experiment, not an unconditional platform default: the SDK documents an authority tradeoff because the moved material arrives in a user message.

#### Tradeoffs

- **Provider coupling:** cache controls belong inside Claude and Codex adapters. A generic `cacheMode` that pretends the providers have identical semantics would weaken the backend seam.
- **Authority changes:** moving dynamic content out of a privileged system block may improve cache hits while slightly weakening instruction priority.
- **False confidence:** a high cache-hit ratio can coexist with an oversized prompt. Cost improves while context pressure does not.
- **Telemetry volume:** prompt fingerprints and token counts are useful; storing full prompt bodies again would create duplication and potentially expose sensitive text.
- **Continuity:** altering instructions on a resumed provider thread may rotate or invalidate continuity. That behavior must be verified per adapter.

#### Incorporation sketches

**Sketch A — complete conversation usage telemetry first.**

1. Extend the normalized conversation turn result with fresh input, cached input, cache-creation input where available, output, and reasoning-token fields.
2. Populate the fields in each provider adapter from its native usage frame.
3. Reuse the existing `AgentCallUsageMetrics` path and persisted conversation slots.
4. Emit one structured per-turn usage event containing backend, model, effort, token classes, cost, duration, and cache-hit ratio—never prompt text.
5. Show aggregate cache behavior only after per-turn data is trustworthy.

**Sketch B — make instruction layers explicit and fingerprintable.**

Treat the assembled prompt as ordered segments:

1. Stable Command Center core and safety contract.
2. Stable backend/tool definitions.
3. Session-stable project, worktree, profile, and alignment material.
4. Turn-dynamic task content and runtime notices.

Compute segment byte/token estimates and hashes for diagnostics. The composer remains the source of actual text; the diagnostic view describes composition without copying secrets into a second store.

**Sketch C — provider-native cache experiment.**

- For Claude, expose the SDK's dynamic-section exclusion option through the Claude adapter behind an experiment flag and verify authority, cache reads, first-token latency, and task success.
- For Codex, rely on provider behavior unless the SDK exposes a supported cache control. Do not invent client cache keys that the provider ignores.
- Run cold, warm, and post-compaction cases separately.

**Project AGENTS.md / skills contribution.** Keep root instructions stable and place situational procedures behind read-on-demand steering or skills. Avoid timestamps, generated state, or frequently changing inventories in the persistent root contract. Command Center already follows part of this pattern; pruning should be based on prompt-segment measurements rather than aesthetic preference.

#### Guardrails and measures

- Cache-read tokens as a share of cache-eligible input.
- Cache writes per successful task.
- Uncached input cost, total cost, and time-to-first-token.
- Prompt-segment size and churn rate.
- Task success and continuity-reset rate.
- Separate cold-start and steady-state reporting.

---

## 2. Lean persistent prompts and tool catalogs

### General approach

Every persistent instruction and eagerly advertised tool competes for attention on every turn. A lean prompt keeps only the small, high-signal contract needed everywhere. Specialized procedures, examples, reference documents, and tool details are loaded when the task actually reaches them.

This is progressive disclosure applied to both instructions and capabilities:

- A compact root contract explains invariants and where deeper guidance lives.
- Skill descriptions act as a small index; full skill bodies load only when triggered.
- Tool groups expose an outline or search surface before every schema is injected.
- Reference documents appear as paths, descriptions, and retrieval commands rather than full bodies.

Anthropic's [context-engineering guidance](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) recommends the smallest high-signal context that still supports the decision. Its reports on [advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use) and [code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp) show large vendor-run reductions from tool search, lazy loading, and programmatic filtering. Those headline figures are illustrative rather than a promise for Command Center, but the architectural lesson is sound.

### Command Center assessment

**Fit: very strong.** Command Center already contains several good disclosure patterns:

- Reference documents are injected as path/description pointers rather than full content.
- Managed Claude and Codex skills are delivered on demand.
- `cctl` help is organized as a command graph rather than one enormous manual.
- Agent-profile listings omit instruction bodies; callers fetch one qualified profile when needed.
- MCP servers and tools can be disabled through existing overrides.

The gaps are also concrete:

- The always-on Command Center context and ask guidance are sizeable even though detailed procedures already exist in the `agent-context` and `cc-cli` skills.
- The MCP composer eagerly describes configured servers. Existing discovery caching is for UI/inventory management, not model-side lazy loading.
- Claude stdio tool filtering can deny a call without necessarily removing the schema from the prompt.
- Provider-native tool-search capabilities are not deliberately configured or measured by Command Center.

Relevant seams include `src/lib/prompt/sdk-driver.ts`, `src/lib/mcp/composer.ts`, `src/lib/mcp/compose-for-conversation.ts`, backend MCP translation modules, managed-skill bridges, and the agent-profile composer.

#### Tradeoffs

- **Discovery misses:** a tool the model never sees cannot be selected. Safety-critical and recovery tools may need to remain eager.
- **Extra round trips:** search-then-load adds latency and sometimes another model step, although round trips are usually cheaper than permanently carrying a large catalog.
- **Prompt fragmentation:** too many tiny skills can shift cost from model context to human memory and unreliable invocation.
- **Provider differences:** one backend may support true deferred schemas while another only supports call-time filtering.
- **Hidden duplication:** the same rule in AGENTS.md, a managed skill, an agent profile, and runtime guidance wastes tokens and creates maintenance drift.

#### Incorporation sketches

**Sketch A — a prompt bill of materials.**

Add a developer-facing diagnostic view for a conversation runtime:

- Segment name and owner.
- Stable, session-stable, or turn-dynamic classification.
- Estimated tokens and bytes.
- Hash/fingerprint and last-change reason.
- Whether the segment is cached, provider-generated, or unavailable to inspect.
- Tool counts by server, with eager/deferred/disabled state where the backend exposes it.

This is the prerequisite for deciding what to trim. It should be diagnostics, not another canonical prompt representation.

**Sketch B — shrink the always-on Command Center block.**

Keep worktree identity, safety constraints, mandatory communication protocol, and the one-line path to `cctl` help. Move procedural command detail that the agent can retrieve from managed skills out of the persistent block. Preserve project alignment and agent-profile instructions as privileged session material.

The change should be tested as a prompt-contract migration: compare task success, tool-discovery failures, clarification requests, and total input—not only the number of lines removed.

**Sketch C — explicit minimal capability surfaces.**

Build on existing MCP overrides rather than adding a parallel tool registry:

- Default unused whole servers off for a session or workflow role.
- Keep a small eager set for universally required operations.
- Enable provider-native tool search for the rest where supported.
- Record which deferred tool was searched, loaded, selected, or missed.
- Treat provider-native discovery as an adapter capability with honest `supported` / `unsupported` behavior.

**Sketch D — project-owned guidance stays project-owned.**

Repository-specific testing, logging, architecture, and workflow rules belong in this project's AGENTS.md, steering files, and project skills. Cross-project `cctl` protocol belongs in the managed Command Center skill bundle. Agent profiles remain prompt identity only; they should not absorb tool policy or model-routing policy.

#### Guardrails and measures

- Persistent prompt tokens per new runtime.
- Eager tool-schema tokens and number of advertised tools.
- Tool-search steps, discovery misses, and fallbacks.
- Duplicate-rule inventory with one declared owner per rule.
- Task success, time-to-first-tool, and total turns.
- A must-remain-eager allowlist justified by observed need.

---

## 3. Context lifecycle and stale-observation masking

### General approach

Long-running agents accumulate file reads, search results, test logs, directory listings, old plans, and superseded decisions. Much of that history remains useful as an audit trail but no longer deserves equal weight in the active working context.

A safe context-lifecycle strategy separates three things:

1. **Immutable history:** the lossless transcript remains available.
2. **Durable working state:** current objective, accepted decisions, files changed, validation state, open questions, and exact evidence handles.
3. **Recent trajectory:** enough uncompressed turns and tool interactions to preserve local reasoning and recovery context.

Older observations can then be masked or represented by auditable handles when a fresh agent context is seeded. The strongest coding-agent evidence comes from [The Complexity Trap](https://arxiv.org/abs/2508.21433), which found environment observations dominated context and that rolling-window masking roughly halved costs on SWE-bench agents without a significant solve-rate loss. [AgentDiet](https://arxiv.org/abs/2509.23586) reports similar input reductions on coding benchmarks. Both are recent research results, not proof that one fixed masking policy will work for every Command Center workload.

LLM summarization alone is not a sufficient strategy. It can cost another model call, smooth over an incorrect assumption, omit an exact edit anchor, or cause the agent to perform more work. The safe pattern is recent raw context plus structured durable state plus exact recovery handles.

### Command Center assessment

**Fit: strong at context boundaries; limited inside active opaque provider sessions.** Command Center owns a lossless transcript and already has sophisticated context artifacts:

- Transcript logical units keep a tool result with its originating tool call.
- Rendering supports outlines, message/sequence ranges, search, tool detail levels, and byte budgets.
- Compactions track both source freshness and prompt/schema/model drift.
- Delta compaction preserves non-superseded decisions and mechanically enforces monotonic source coverage.
- Graph lanes already have a context-limit gate and context-rotation behavior.

The crucial limitation is provider continuity. Claude and Codex sessions are resumed through opaque provider references. Command Center does not reconstruct and resend an editable full history on every turn. It therefore cannot silently remove old observations from an already-running provider thread. Masking can improve:

- `cctl` transcript reads.
- Compaction inputs and outputs.
- New conversations or graph-lane contexts seeded from an artifact.
- A future explicit "restart from projected context" operation.

It cannot honestly claim to shrink an active resumed thread without backend support.

#### Tradeoffs

- **Semantic supersession is hard:** two reads of the same path may differ by range, commit, working-tree state, or intervening writes.
- **Summary drift:** a concise artifact can preserve a wrong conclusion more confidently than raw history did.
- **Recovery cost:** excessive masking causes re-fetches and can lengthen the trajectory.
- **Cache interaction:** starting a fresh projected context may break a warm provider prefix even while reducing context size.
- **Continuity loss:** a fresh context can lose provider-native planning state or learned interaction patterns.
- **Security and privacy:** derived artifacts must inherit the source material's access boundary and retention policy.

#### Incorporation sketches

**Sketch A — expose stable logical-unit handles.**

Promote the transcript's existing unit segmentation into the read API. Each outline entry should carry a stable sequence range, byte size, tool relationship, and exact follow-up command. A handle such as `seq:120-137` remains stable as the transcript grows; a positional `chunk 4` does not.

If one logical unit exceeds the stdout budget, spill it intact to a file rather than splitting it mid-record. This preserves code, JSON, errors, and paired tool context.

**Sketch B — conservative stale-observation projection.**

Before compaction or a projected-context restart:

1. Pair tool uses and results.
2. Derive a conservative resource key only for understood, read-only operations.
3. Mark an earlier successful read superseded by a later successful read of the same resource and compatible scope.
4. Never mask writes, failures, ambiguous calls, safety warnings, accepted decisions, or the current validation failure.
5. Record every omission with its original sequence range and replacement sequence.

Start with a narrow, auditable class such as repeated status reads or identical file-range reads. Do not begin with an LLM deciding what is obsolete.

**Sketch C — explicit restart from projected context.**

If later warranted, make context restart a visible operation:

- Preserve the original transcript and provider reference.
- Generate or refresh a compaction.
- Present the projected seed and its source coverage.
- Start a new backend context with the stable core, current artifact, exact open evidence handles, and a recent raw tail.
- Record the lineage and compare results with uninterrupted continuity.

This belongs behind a backend capability because restart and resume semantics differ.

**Project AGENTS.md / skills contribution.** A project rule can require re-reading mutable state immediately before acting and treating older reads as historical. The existing `cc-cli` skill already teaches compaction-first, outline-second, bounded-window-third retrieval. Keep detailed log and source-navigation recipes in project skills, where they load only when relevant.

#### Guardrails and measures

- Input tokens per turn before and after projection.
- Compaction-generation tokens and latency.
- Re-fetch rate and additional tool calls.
- Task success, semantic-review score, and exact-constraint retention.
- Superseded-observation counts by deterministic rule.
- Continuity resets and recovery failures.
- A sampled human audit of every new masking rule before broad enablement.

---

## 4. Progressive, recoverable tool output

### General approach

Tool results are often the largest controllable part of an agent trajectory. The correct default is not "print everything in case it matters" and not "truncate silently." It is a bounded digest that tells the agent:

- What exists.
- What was returned.
- What was omitted and how much.
- The stable handle for each item.
- The exact command or range that retrieves more.
- Where a full result was written if stdout would be excessive.

The disclosure ladder is:

1. Counts and high-level status.
2. Bounded outline with stable handles.
3. Scoped detail for one handle or range.
4. Explicit full output, spilled to a file past a threshold.

Round trips are usually cheaper than carrying a large result through every subsequent turn. But compression must remain recoverable. JetBrains' [RTK benchmark](https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/) is a useful warning: at low reasoning effort the RTK arm showed median increases of 7.6% in cost and 13.8% in turns, while cost was approximately neutral at high effort. The causes were mixed, so the defensible conclusion is that local output reduction can trigger compensating trajectory behavior—not that shortened output alone always causes more calls.

### Command Center assessment

**Fit: very strong, and much of the design already exists.** `cctl` has several production-ready pieces:

- Conversation reads support bounded outlines, ranges, search, and tool detail levels.
- Ticket attachment indexes use stable IDs and print exact retrieval commands.
- Workflow and spec reads default to outlines and targeted selectors.
- Spec reads enforce a 60 KB stdout budget and automatically write oversized content to a content-addressed `.cc/temp` file with byte count, digest, format, and reason.
- Log analysis already uses ranked limits and explicit finding budgets.

The implementation is uneven. Conversation truncation does not always expose an exact continuation handle. Ticket attachment retrieval can still dump a full body. Reference documents have no ranged `get` command. The spec spill-to-file behavior has not been generalized.

Relevant seams include:

- `src/lib/conversations/transcript-logical-units.ts` and `transcript-render.ts`.
- `src/cli/commands/conversation.ts`.
- `src/cli/commands/spec/read.ts` and `read-envelopes.ts`.
- `src/lib/tickets/attachment-index.ts` and `src/cli/commands/ticket.ts`.
- `src/lib/workflows/primitives/artifact-registry.ts`.
- `src/lib/logging/log-analysis/`.

#### Tradeoffs

- **Extra calls:** a bounded default can require a drill-down call. This is acceptable only if the next command is obvious and cheap.
- **Silent incompleteness:** omission metadata is part of correctness, not decoration. A truncated payload without it is worse than a large payload.
- **Unstable handles:** array positions and relevance ranks can change; sequence ranges, IDs, paths, and content digests are safer.
- **Upstream loss:** Command Center cannot recover bytes a provider or native tool already discarded. Artifact capture must happen at the owning boundary.
- **Temporary-file accumulation:** spill artifacts need bounded retention and must not become durable reference documents automatically.
- **Generic-envelope temptation:** domains should keep their meaning. A shared bounded-output helper can standardize budgets and receipts without flattening every command into one universal response type.

#### Incorporation sketches

**Sketch A — extract the spec spill behavior as a shared composable helper.**

The helper should:

- Accept text and structured renderers plus an explicit stdout budget.
- Preserve the domain command's normal compact output when under budget.
- Write oversized output atomically beneath `.cc/temp/`.
- Return a typed receipt containing path, media type, bytes, SHA-256, truncation/spill reason, and exact follow-up actions.
- Never register the temporary artifact as durable unless the user or workflow explicitly promotes it.

First adopters should be `conversation read`, compaction `get`, ticket attachment `get`, and large diagnostic views.

**Sketch B — sequence-addressed transcript retrieval.**

Return the server's logical-unit sequence metadata through the CLI instead of dropping it. Every omitted region should include `total`, `returned`, `truncated`, and either a next cursor or an exact `--seq-range` command. Structured JSON mode must carry the same facts.

**Sketch C — a recoverable tool-result manifest for CC-owned operations.**

For large results Command Center controls, retain:

- A bounded excerpt.
- Total and retained bytes.
- Digest.
- Artifact path or logical handle.
- Whether truncation occurred in Command Center, the provider, or the underlying tool.
- Exact retrieval command.

The UI can render the excerpt collapsed and offer "view full result" without injecting the full body into every agent-facing view.

**Sketch D — project validation and log output.**

For tools outside Command Center's direct control, keep project wrappers and skills responsible. Registered validation commands should suppress passing-test noise, retain complete failure detail, disable color, bail where appropriate, and spill pathological output. Command Center's native validation service should continue to own admission, ordering, and exit status.

#### Guardrails and measures

- Default output bytes/tokens by command.
- Percentage of calls that require a drill-down.
- Follow-up success rate and invalid-handle rate.
- Spill count, artifact size, and retention cleanup.
- Tool-call count and total trajectory cost.
- Task failures attributable to omitted or upstream-truncated evidence.
- Contract tests that every truncated response states what was omitted and how to retrieve it.

---

## 5. Bounded success and stop conditions

### General approach

Agents often spend excess tokens because the task has no explicit stopping boundary. Instructions such as "think deeply," "consider several approaches," or "make it production-ready" can encourage exploration, polish, and validation after the actual requirement is satisfied.

A bounded execution contract gives the agent:

- The objective.
- The allowed scope.
- Concrete acceptance criteria.
- Relevant non-goals and invariants.
- The smallest-sufficient-change expectation.
- The current execution budget.
- A stop condition and escalation path.

The model should not enforce its own iteration budget. Deterministic code counts attempts, runs validations, opens circuit breakers, and decides whether another turn is admitted. The model uses the budget information to choose a sensible next action.

A recent preregistered study of coding prompts found that open-ended requests to develop and compare multiple approaches could multiply reasoning usage, while a bounded-efficiency template retained success with materially less reasoning for some models. The tasks were small and the work is recent, so it supports a measured design direction rather than a universal numeric claim. [Study](https://arxiv.org/abs/2608.01347)

### Command Center assessment

**Fit: exceptionally strong.** This is already Command Center's architectural direction:

- Graph contexts carry tasks and acceptance criteria.
- Iteration policy, hard limits, circuit breakers, context-limit gates, and total-pass backstops are mechanically enforced.
- Registered validation runs through a central service with explicit cost and admission policy.
- Script validation runs before semantic agent validation.
- Structured-output gates validate the agent's artifact rather than trusting prose.
- Filesystem write boundaries and workflow task completion are mechanically controlled.

One useful gap is that the graph engine knows the iteration budget, but the main iteration prompt does not clearly expose current, maximum, and remaining iterations. The agent can therefore be near a hard stop without using that fact to prioritize acceptance criteria over optional polish.

Relevant seams include `src/lib/workflow-graph/iteration-prompt.ts`, `execution-loop.ts`, `config-schemas.ts`, `resolve-config.ts`, the circuit-breaker and context-limit primitives, and `src/lib/validation/service.ts`.

#### Tradeoffs

- **Bad criteria cause premature completion:** an explicit stop condition is only as good as the acceptance criteria.
- **Local optimization:** "smallest change" can discourage necessary architectural work or root-cause fixes if applied dogmatically.
- **Prompt duplication:** repeating the full contract on every turn wastes the very tokens being saved.
- **Budget gaming:** an agent may rush when shown a low remaining count. The prompt must tell it to surface a blocker rather than declare weak completion.
- **Exploration suppression:** some design and debugging tasks genuinely need comparison. The contract needs an escape hatch for unresolved, consequential choices.

#### Incorporation sketches

**Sketch A — add a compact execution-budget section to graph prompts.**

At each iteration include only current facts the orchestrator owns:

- Current task and acceptance criteria.
- Iteration `n` of `max` and remaining count.
- Current deterministic validation state.
- Scope/non-goals already declared for the context.
- A short instruction: satisfy the current criteria before optional polish; do not expand scope; surface a concrete blocker if completion is unsafe.

The engine remains the sole authority for counting and stopping. Never ask the agent to echo iteration numbers in structured output.

**Sketch B — derive, do not duplicate, the execution contract.**

Compose the prompt section from existing workflow/task fields and resolved config. Do not add a second free-text "efficiency prompt" that can contradict acceptance criteria, validation policy, or context limits.

**Sketch C — preserve cheap-gate-first ordering.**

Continue running deterministic validators before semantic agent validators. Give the agent only actionable failures, not pages of successful checks. When all deterministic gates pass, use the model for the part only a model can judge: whether the change satisfies intent and is appropriately scoped.

**Sketch D — project AGENTS.md / skill guidance.**

A compact project-level rule is appropriate:

> Make the smallest sufficient change within the stated scope. Success means the acceptance criteria and registered validation pass. Stop when they do; compare alternatives only when the choice remains consequential and unresolved.

Keep detailed task-authoring advice in a project skill rather than expanding root AGENTS.md. Root guidance should contain only durable rules supported by repeated failures.

#### Guardrails and measures

- Turns and tool calls per completed task.
- Patch size and touched-file count, normalized by task.
- Iterations spent after all acceptance criteria first pass.
- Reopen, reviewer-loss, and regression rates.
- Premature-completion incidents.
- Validation cost by deterministic versus model gate.
- Human assessment of whether the smallest change was actually sufficient.

---

## 6. Adaptive model and reasoning-effort routing

### General approach

Not every operation needs the most capable model or the highest reasoning effort. Routing assigns cheap, bounded work to an economical configuration and reserves stronger configurations for ambiguous, high-impact, or repeatedly failing work.

Routing can be:

- **Static by role or task class:** naming, classification, compaction, implementation, validation, or plan repair each receive an explicit profile.
- **Deterministic escalation:** start at a configured base and move to a stronger tier after defined failure evidence.
- **Learned or model-based:** a router predicts difficulty and selects a model.
- **Cascade-based:** a cheap model attempts the task; a verifier or failure signal decides whether to escalate.

[RouteLLM](https://proceedings.iclr.cc/paper_files/paper/2025/hash/5503a7c69d48a2f86fc00b3dc09de686-Abstract-Conference.html) demonstrates that routing can substantially reduce benchmark cost at matched aggregate quality. Research on [optimal test-time compute](https://proceedings.iclr.cc/paper_files/paper/2025/hash/1b623663fd9b874366f3ce019fdfdd44-Abstract-Conference.html) similarly supports allocating more computation to harder questions. These results establish a useful principle, not a ready-made production router for autonomous coding.

The same principle applies inside a reasoning model. [How Well do LLMs Compress Their Own Chain-of-Thought?](https://arxiv.org/abs/2503.01141) finds task-specific minimum reasoning lengths and a general length–accuracy tradeoff, while [TALE](https://aclanthology.org/2025.findings-acl.1274/) reports meaningful reasoning-token reductions from adaptive budgets with a modest average quality cost. Together they support effort that adapts to the task rather than one fixed low-token reasoning policy.

Routing usually saves **dollars**, not necessarily total tokens. A cheaper model may use more tokens, and a mistaken cheap attempt followed by an expensive retry can cost more than starting strong.

### Command Center assessment

**Fit: useful, but only after measurement and at explicit boundaries.** Command Center already performs role-specific static routing:

- Conversation model and effort resolve through explicit turn, scoped/last-used, configured profile, and backend defaults.
- Naming uses a cheap, low-effort isolated task.
- Compaction has separate model/effort configuration.
- Plan repair defaults to a strong, high-effort configuration.
- Graph implementers and validators carry concrete backend, model, and reasoning effort through the global → workflow → context cascade.

This is a good foundation. It also reveals constraints:

- Agent profiles are prompt identity only and must not become runtime-routing policy.
- Graph assignments are resolved and snapshotted for reproducibility.
- Continuity fingerprints include backend, model, and effort; changing an assignment rotates context.
- A backend switch must never reuse an opaque provider reference accidentally.

#### Tradeoffs

- **Routing regret:** a weak first attempt can introduce flawed code or misleading state that survives escalation.
- **Classifier overhead:** an LLM router adds cost, latency, and another failure mode.
- **Distribution shift:** task difficulty and model behavior change as providers release updates.
- **Continuity disruption:** switching model, effort, or backend can require a fresh lane context.
- **Evaluation complexity:** average quality can hide regressions on security, migrations, ambiguous requirements, or large refactors.
- **User expectations:** automatic model changes must be visible, explainable, and overridable.

#### Incorporation sketches

**Sketch A — advisory routing telemetry before automatic routing.**

Record the configuration actually used, task role/class, iterations, validation failures, escalations, final outcome, cost, and latency. Build an offline report that asks, "Could this successful task have used the configured lower tier?" before allowing the system to act on the answer.

**Sketch B — deterministic escalation tiers.**

Extend the workflow config cascade with an optional, typed policy that resolves and snapshots alongside assignments. A first version could contain:

- Concrete base assignment.
- One or more concrete escalation assignments.
- Mechanical triggers such as repeated semantic rejection, circuit-breaker approach, or a declared high-risk task class.
- Maximum escalations.

A pure router immediately before continuity and dispatch selects the concrete assignment and emits a reason code. Catalog validation remains mandatory. Infrastructure failures should not trigger a more expensive reasoning model.

**Sketch C — route only at safe boundaries.**

Prefer task start, context rotation, or explicit retry boundaries. If an assignment changes, intentionally rotate continuity according to the existing fingerprint rule and seed the new context with durable state. Do not silently switch the model halfway through an opaque thread.

**Sketch D — placement.**

- Cross-project routing mechanics and audit data belong in native Command Center code/config.
- This repository's preferred task taxonomy and default assignments belong in project workflow templates or a project skill.
- Runtime routing does **not** belong in agent profiles or prose-only AGENTS.md rules; those surfaces cannot enforce, validate, or audit the decision.

#### Guardrails and measures

- Cost and latency per successful task by route.
- Escalation rate and reason distribution.
- Routing regret against a strong-model control sample.
- Continuity rotations and failures after escalation.
- Quality by task class, especially high-risk tails.
- Total tokens, not only dollar cost.
- Periodic re-baselining when model versions or pricing change.

---

## 7. Intact-chunk retrieval before lexical or lossy compression

### General approach

Lexical prompt compression deletes words or rewrites text to fit a smaller token budget. It can work for long, redundant natural-language support material, but it is dangerous for instructions, code, schemas, commands, errors, numeric limits, and ordered procedures.

The safer order is:

1. Filter irrelevant sources.
2. Retrieve and rerank relevant documents, sections, files, transcript units, or ranges.
3. Preserve selected chunks verbatim.
4. Provide stable handles for nearby or omitted chunks.
5. Use a generated summary as an index, not as the sole remaining evidence.
6. Apply word-level compression only to explicitly non-authoritative prose, if it still produces an end-to-end win.

An independent comparison, [Characterizing Prompt Compression Methods](https://arxiv.org/abs/2407.08892), found query-aware extractive reranking generally more reliable than abstractive or token-pruning compression across its evaluated tasks. [RECOMP](https://proceedings.iclr.cc/paper_files/paper/2024/hash/bda88ed2892f5e61c9a9bf215c566913-Abstract-Conference.html), [LongLLMLingua](https://aclanthology.org/2024.acl-long.91/), and [LLMLingua-2](https://aclanthology.org/2024.findings-acl.57/) show that learned compression can work on selected retrieval and QA workloads. [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/) explains why removing irrelevant material can sometimes improve reasoning. None of those results justifies rewriting an active coding agent's governing contract.

### Command Center assessment

**Fit: reject a general lexical compressor; strongly support intact retrieval.** Command Center already has better primitives to deepen:

- Transcript logical units and sequence ranges.
- Compaction artifacts with source references and freshness metadata.
- Reference-document pointers.
- Ticket attachments with stable IDs.
- Spec search/get/delta surfaces.
- Artifact registration and content-addressed spill files.

These can form a retrieval layer without altering authoritative bytes. The platform should preserve a clear distinction between:

- **Canonical source:** exact file, transcript, attachment, specification, or command result.
- **Derived index:** outline, ranking, compaction, or summary with source handles.
- **Ephemeral excerpt:** bounded content selected for one turn.

#### Tradeoffs

- **Retrieval misses:** the right fact cannot help if it is not selected. Recovery needs to be obvious and cheap.
- **Index staleness:** files, tickets, transcripts, and specs evolve at different rates.
- **Embedding cost and privacy:** semantic indexes create computation, storage, and data-governance obligations.
- **Ranking opacity:** a model may over-trust the top result and ignore uncertainty.
- **Summary authority confusion:** users and agents may treat a derived artifact as canonical unless the UI and schema distinguish them.
- **Compressor overhead:** preprocessing can erase latency or cost savings, especially on short prompts.

[Prompt Compression in the Wild](https://arxiv.org/abs/2604.02985) reinforces that final point: its best reported end-to-end speedup was about 18%, and only when prompt length, compression ratio, hardware, and preprocessing aligned. Outside that operating window, compressor overhead erased the gain.

#### Incorporation sketches

**Sketch A — retrieval over existing stable handles before embeddings.**

Start with deterministic search and metadata already present:

- Transcript search returning logical units and sequence ranges.
- Reference-document search returning path, heading, line range, digest, and freshness.
- Ticket attachment search returning stable attachment IDs.
- Spec search returning exact element handles.

Use lexical/regex search and domain filters first. Add semantic retrieval only where measured misses justify its complexity.

**Sketch B — source-grounded compaction.**

Keep the current generated brief, but strengthen its role as an index:

- Every decision, blocker, file, command, and open question carries one or more source handles.
- Superseded statements remain traceable.
- A compact artifact reports coverage, stale-behind count, prompt/schema/model version, and exact refresh command.
- Retrieval can fetch the intact source unit without regenerating the summary.

**Sketch C — opt-in lossy derivatives for long support prose only.**

If a compressor is later evaluated, constrain it to user-provided background prose or retrieved documentation. Never transform:

- System, developer, AGENTS.md, skill, charter, or profile instructions.
- Source code, diffs, patches, schemas, or structured payloads.
- Commands, paths, identifiers, exact errors, numbers, units, or negations.
- Current validation failures or active execution state.

Store the derivative beside an exact source handle and label it non-authoritative. Evaluate compressor cost and recovery calls as part of the same trajectory.

**Project AGENTS.md / skills contribution.** Keep source-navigation recipes local: use `rg`, bounded file reads, `cctl ... --outline`, exact range retrieval, and compaction-first conversation reads. A project skill can encode domain-specific search paths and source-of-truth rules; the root AGENTS.md should not grow a generic compression tutorial.

#### Guardrails and measures

- Retrieval recall on known required facts and constraints.
- Task success and semantic-equivalence review.
- Exact-constraint loss incidents.
- Recovery/drill-down calls after a miss.
- Index freshness and stale-result rate.
- End-to-end cost including retrieval, embedding, reranking, or compressor calls.
- A hard prohibition on lossy transformation of authoritative classes.

---

## Cross-cutting Command Center design

### Do not create an `agentEfficiency` mega-subsystem

These optimizations belong with the decisions they affect:

| Responsibility | Correct owner |
|---|---|
| Provider cache controls and native lazy-tool support | `src/lib/agent-backends/<backend>/` adapters |
| Normalized token and cost vocabulary | AgentCall/backend-neutral usage schemas |
| Prompt segment composition | Conversation prompt/runtime composition |
| Transcript units, compaction, freshness, and projection | Conversations and context-artifacts domains |
| Bounded CLI output and spill receipts | Shared CLI helper plus domain renderers |
| Retry, stop, validation, and execution budgets | Workflow graph and validation service |
| Model/effort policy and escalation | Workflow config resolution plus backend catalog validation |
| Repository-specific work style and navigation | Project AGENTS.md, steering, and project skills |

This preserves Command Center's composable-module philosophy and avoids a second orchestration path.

### Measurement foundation

Before optimizing, Command Center needs a joined view of usage and outcome. A per-call usage record should be able to answer:

- Which project, session, conversation, workflow execution, context, task, and role produced the call?
- Which backend, model, reasoning effort, and agent profile were used?
- How many uncached input, cache-write, cache-read, output, and reasoning tokens were consumed?
- What was the estimated or provider-reported cost and latency?
- Was the call an implementer, validator, compaction, naming, plan-repair, collaboration, router, or ordinary conversation call?
- Which tool calls, retries, context rotations, and escalations followed?
- Did deterministic validation pass, did semantic validation pass, and was the task later reopened?

Prompt bodies need not be retained for this. Stable segment fingerprints, sizes, ownership labels, and provider request identifiers are sufficient for most diagnosis.

### Recommended delivery sequence

#### Phase 0 — establish the denominator

1. Complete conversation token/cache telemetry.
2. Define task-outcome joins and cost-per-success reports.
3. Add prompt/tool composition diagnostics.
4. Build a representative evaluation corpus from completed Command Center work.

#### Phase 1 — no-regret structural savings

1. Generalize bounded CLI output and content-addressed spill receipts.
2. Add stable transcript chunk handles and exact omission commands.
3. Expose iteration budgets and compact stop conditions in graph prompts.
4. Prune duplicated always-on Command Center instructions only after segment accounting.

#### Phase 2 — provider and context experiments

1. A/B Claude prefix-stability options.
2. Deliberately configure and observe provider-native lazy tool search.
3. Pilot deterministic stale-observation projection for a narrow read-only class.
4. Evaluate explicit projected-context restart against uninterrupted continuity.

#### Phase 3 — routing

1. Produce advisory routing analysis from accumulated data.
2. Introduce deterministic escalation tiers at context boundaries.
3. Add learned routing only if simple policy leaves a material, measured opportunity.

### Explicit non-goals

- No Caveman-style output dialect.
- No global word-deletion compressor.
- No LLM deciding its own retry count or whether tests passed.
- No silent context truncation.
- No backend-neutral cache abstraction that erases provider semantics.
- No automatic mid-thread model switch without explicit continuity handling.
- No duplicate prompt policy in AGENTS.md, profiles, managed skills, and runtime blocks.

---

## Evaluation protocol

Each optimization should be evaluated as a complete agent trajectory.

### Experimental shape

- Start with a 20–50 task pilot across debugging, implementation, refactoring, documentation, workflow authoring, and review. Use the observed variance to perform a power/sensitivity analysis and set the decision sample size against the predeclared non-inferiority margin; the pilot alone does not establish quality preservation.
- Include easy and hard tasks plus exact-constraint-sensitive cases such as migrations, permissions, and structured output.
- Run at least three paired repetitions per arm where cost permits.
- Hold model, reasoning effort, harness, repository state, and validation constant unless that factor is the treatment.
- Compare against both the current baseline and the simplest plausible alternative.

### Primary decision metric

**Provider cost per successful, non-reopened task**, with a predeclared non-inferiority margin for quality.

### Secondary metrics

- Uncached, cached-read, cache-write, output, and reasoning tokens.
- Context occupancy and prompt/tool segment size.
- Tool calls, turns, retries, validators, sub-agents, and context rotations.
- Wall-clock latency and time-to-first-token.
- Deterministic validation, semantic review, scope, robustness, and operator comprehension.
- Recovery calls caused by omitted or compressed information.
- Results by task class rather than only one aggregate average.

### Stop rules for an experiment

Disable or revise a treatment when it:

- Produces a statistically or operationally meaningful quality regression.
- Increases total cost despite shrinking a local token counter.
- Causes unrecoverable evidence loss.
- Creates repeated discovery, continuity, or routing failures.
- Requires enough prompt instructions to erase its own savings.

---

## Final recommendation

Command Center should pursue token efficiency as **context engineering plus deterministic orchestration**, not as a prose-compression feature.

The best first investments are already adjacent to proven code:

1. Preserve conversation cache/token metrics that the adapters currently receive.
2. Turn the spec reader's bounded, content-addressed spill behavior into a shared CLI capability.
3. Carry stable transcript handles and explicit omission metadata end to end.
4. Show workflow agents their real execution budget while keeping all enforcement mechanical.
5. Inventory and reduce persistent prompt/tool surface.

Those steps are broadly useful across every project Command Center manages, have clear ownership in the existing architecture, and preserve the agent's reasoning inputs. Context projection and adaptive routing should follow as measured, reversible pilots. Lexical compression should remain outside the critical path unless a narrowly scoped, recoverable experiment demonstrates an end-to-end win.

## Sources

### Provider and practitioner guidance

- [OpenAI — Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)
- [OpenAI — Latest model guidance](https://developers.openai.com/api/docs/guides/latest-model)
- [Anthropic — Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
- [Anthropic — Advanced tool use](https://www.anthropic.com/engineering/advanced-tool-use)
- [Anthropic — Code execution with MCP](https://www.anthropic.com/engineering/code-execution-with-mcp)
- [Anthropic — Writing effective tools for agents](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [JetBrains — RTK token-savings benchmark](https://blog.jetbrains.com/ai/2026/07/rtk-claude-code-token-savings/)

### Research

- [Don't Break the Cache: An Evaluation of Prompt Caching for Long-Horizon Agentic Tasks](https://arxiv.org/abs/2601.06007)
- [The Complexity Trap: Simple Observation Masking Is as Efficient as LLM Summarization for Agent Context Management](https://arxiv.org/abs/2508.21433)
- [Reducing Cost of LLM Agents with Trajectory Reduction](https://arxiv.org/abs/2509.23586)
- [SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering](https://proceedings.neurips.cc/paper_files/paper/2024/hash/5a7c947568c1b1328ccc5230172e1e7c-Abstract-Conference.html)
- [RouteLLM: Learning to Route LLMs with Preference Data](https://proceedings.iclr.cc/paper_files/paper/2025/hash/5503a7c69d48a2f86fc00b3dc09de686-Abstract-Conference.html)
- [Scaling LLM Test-Time Compute Optimally](https://proceedings.iclr.cc/paper_files/paper/2025/hash/1b623663fd9b874366f3ce019fdfdd44-Abstract-Conference.html)
- [Same Task, Different Work: Prompt-Induced Waste in Coding Agents](https://arxiv.org/abs/2608.01347)
- [How Well do LLMs Compress Their Own Chain-of-Thought?](https://arxiv.org/abs/2503.01141)
- [TALE: Token-Budget-Aware LLM Reasoning](https://aclanthology.org/2025.findings-acl.1274/)
- [Characterizing Prompt Compression Methods](https://arxiv.org/abs/2407.08892)
- [RECOMP: Improving Retrieval-Augmented LMs with Compression and Selective Augmentation](https://proceedings.iclr.cc/paper_files/paper/2024/hash/bda88ed2892f5e61c9a9bf215c566913-Abstract-Conference.html)
- [LongLLMLingua: Accelerating and Enhancing LLMs in Long Context Scenarios](https://aclanthology.org/2024.acl-long.91/)
- [LLMLingua-2: Data Distillation for Efficient and Faithful Task-Agnostic Prompt Compression](https://aclanthology.org/2024.findings-acl.57/)
- [Lost in the Middle: How Language Models Use Long Contexts](https://aclanthology.org/2024.tacl-1.9/)
- [Prompt Compression in the Wild: An Empirical Study of End-to-End Performance](https://arxiv.org/abs/2604.02985)

### Evidence caveat

Provider documentation is authoritative for API behavior but not neutral evidence of workload-level savings. Several agent-context and coding-efficiency studies cited here are recent preprints. Their results justify controlled Command Center experiments, not copying their headline percentages into product promises. The repository-specific recommendations are based on a read-only audit of `main` on 2026-08-15 and should be rechecked against the live code before implementation.
