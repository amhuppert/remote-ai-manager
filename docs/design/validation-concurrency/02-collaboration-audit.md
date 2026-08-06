# Collaboration Audit — validation concurrency design

**Agents:** agent_one (primary/resolver), agent_two. **Rounds:** 1 negotiation round + user clarification. **Outcome:** full agreement; three decisions returned by Alex.

## Convergence at round 0

Both drafts independently landed on the same core, which was never contested: one server-owned validation service that all callers must enter; a global weighted budget; **strict FIFO with no barging** (both reasoned that cheap lint runs would otherwise starve expensive test suites); per-command acquire/release rather than group reservation; fail-fast default with explicit `--wait`; policy-disabled commands as exit-0 no-ops that never touch the scheduler; process-group kill; and scoped-mode guidance in the setup skills. Independent agreement on the FIFO/no-barging trade-off and the exit-0 no-op is the strongest signal in the run.

The drafts differed in emphasis: agent_one was concrete about repository integration surfaces (cascade siblings, help-registry obligations, arch tests, event/log seams); agent_two was stronger on service decomposition, migration, and lifecycle hazards.

## What each agent changed in the other's design

**agent_two → agent_one (accepted, 19 items).** Job-shaped submit/poll/cancel replacing a long-lived HTTP request; `validation.preMerge` ordered list replacing `preMergeCommand` with a clean cutover; dropping the `enabled` flag so an empty command list means disabled (which dissolved a zod-default trap agent_one had to legislate around); leaf-level cascade resolution; per-role implementer/validator policy in v1 (agent_one had deferred it); seed-time snapshot expansion so registry edits can't broaden a running execution; fail-closed identity; a recursion guard against nested wrapper calls; and "capacity waiting is orchestration state, not validation failure."

**agent_one → agent_two (6 of 10 accepted).** The client-liveness lease — agent_two's model handled restarts and explicit cancel but nothing released a job whose initiating agent died mid-wait; per-command timeouts; the all-except selector capability; the concrete integration-surface map; a pinned migration mapping; and code-level verification of the canonical-root claim.

## The four contested items

| Item | Resolution | Basis |
|---|---|---|
| **Args passthrough** | agent_one dropped raw `append`; adopted agent_two's typed `scopeArgs: "paths"` | Both agreed TDD needs single-file runs. agent_two's "guidance is not a capacity guardrail" was decisive — it's the same mechanical-enforcement principle agent_one had argued for the no-op policy, so consistency favored the typed version. |
| **Context-validator default** | agent_one conceded to default-none | agent_one verified the cited evidence directly: `validator-runner.ts:221` already tells validators deterministic checks are "not your responsibility." The default mechanizes an existing instruction rather than changing behavior — which defeated agent_one's "silent behavior change" objection. |
| **SQLite ledger** | agent_one conceded; adopted the crash-safe ledger | agent_one's in-memory argument addressed admission atomicity, not crash recovery. agent_two showed children are spawned *detached* so an abrupt death leaves workers alive while a restarted semaphore reports zero usage — reopening the full budget over orphaned workers. Scope-guarded to ownership/recovery, not history. |
| **Cost > limit** | Escalated to Alex | Correctly categorized objective: does the limit mean a hard capacity guarantee (reject) or an anti-pile-up mechanism (clamp)? Not resolvable by evidence. |

Two amendments improved on the originals: agent_two's owner-only lease token (read-only status calls can't keep abandoned work alive) and the discriminated `{mode:"all"|"only"}` selector (invalid combinations unrepresentable). Naming settled as `cctl validate` by agent_two's concession.

## Escalation and user decisions

Round 1 ended `ask_user` with three questions — one genuine objective conflict plus two decisions the engineering contract reserves for Alex.

- **Oversized costs → reject (b).** The limit is a hard capacity guarantee. agent_two's position; agent_one had mildly preferred clamp but noted preflight made either acceptable. Preflight catches it at workflow create/replace/start/live-edit rather than mid-run.
- **Clean cutover → approved.** `preMergeCommand` and `executeRepoValidationCommand` are removed after all callers migrate, with an architecture test preventing the bypass from reappearing.
- **Seeded limit → 8.**

## Assessment

Each agent conceded on the merits at least once, and both concessions turned on evidence rather than deference — agent_one verified agent_two's prompt citation in source before yielding on validator defaults, and accepted the crash-recovery argument after recognizing its own reasoning had answered a different question. No disagreement was resolved by splitting the difference. The one item neither could settle was correctly identified as a question about intent rather than mechanism and routed to Alex, which is what let round 1 close without a second negotiation cycle.

Residual risks carried into the final design, all flagged in it: cost remains declared rather than measured; validation started outside CC (manual runs, pre-commit hooks) stays unmetered; and the crash-recovery contract needs proving against the real Next.js/Bun server lifecycle before the feature is considered complete.
