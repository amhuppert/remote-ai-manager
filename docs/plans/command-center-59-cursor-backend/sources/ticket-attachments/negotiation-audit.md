# Negotiation audit — Cursor backend LOE (round 0–1)

## Starting positions

- **agent_one (initial draft):** SDK-first. Found `@cursor/sdk` in Cursor's docs and framed the integration as SDK-class (like Codex). Estimated ~9–13k LOC; 2–4 day spike, ~2–3 week v1, +1–2 week parity pass; named Bun compatibility of the in-process SDK as the single biggest swing factor. Grounded CC-side costs in a full seam sweep (Codex adapter 8,966 LOC, testfake third backend, conformance harness, seam ratchet).
- **agent_two (initial draft):** ACP-first, without evaluating the SDK. Ran a live unauthenticated ACP probe of the real binary and mined Codex-integration git history for calibration. Estimated 3 weeks interactive MVP, 4–7 weeks production, 6–10+ weeks full parity with two potential vendor blockers (write confinement, privileged instructions).

## What each side contributed and conceded

**agent_one's cross-review (round 1)** verified `@cursor/sdk` exists via the npm registry (v1.0.27, 2026-08-06) and proposed making the spike a two-transport bake-off instead of pre-committing to ACP; accepted 10 of agent_two's points including two gaps it had missed (the privileged-instruction channel, and `commands/route-handlers.ts` silently mapping non-Codex backends to Claude); conceded the production estimate upward to 4–6 weeks based on agent_two's git-history calibration.

**agent_two's counter-proposal** accepted 7 of 9 proposed changes and rejected 2 — both correctly:

- **ACP stdio MCP**: agent_one had inferred a stdio gap from the probe's `{http, sse}` capability flags; agent_two cited the ACP v1 spec showing stdio is the *required baseline* and those flags advertise the optional extras. agent_one withdrew the claim.
- **Static model catalog**: agent_one proposed a curated static v1 list; agent_two cited Cursor's account/team-specific catalog and "discover, don't hard-code" guidance. Replaced with a minimal default + custom-ID MVP flow and an explicitly-scoped async catalog seam extension.

agent_two also landed the round's most consequential amendment: an **inline SDK loop in the CC server is ineligible**, because concurrent conversations need distinct credential-bearing `CC_*` environments that cannot ride shared `process.env`. The SDK path became a per-conversation isolated Node worker — which simultaneously demoted agent_one's "Bun is the biggest risk" framing to a packaging check.

## Resolution (agent_one as resolver)

All eight of agent_two's remaining disagreements were resolved by adoption (X1 isolated worker, X2 stdio baseline, X3 dynamic models, X4 testfake narrowed to runtime-seam evidence, X5 isolation-first decision weights, X6 settlement-aware cost, X7 full SDK credential lifecycle, X8 conversation-facet-only MVP with a nongoverned-task eligibility gate in production). agent_one's four earlier disagreements had already been resolved by the counter (bake-off adopted, transport-dependent cost, itemized parity gates, codec-work caveat). No disagreements remained; no user escalation was needed.

## Converged outcome

Spike 2–4 days (isolated SDK worker vs ACP child, isolation-first criteria) → interactive Cursor conversations ~3 weeks cumulative → production scoped backend 4–6 weeks cumulative ±30% → parity as independent vendor gates (write confinement provable; privileged instructions likely blocked on Cursor) with a conditional ~1–2 week increment → Collaboration Mode out of scope. ~9–13k LOC retained as secondary calibration only.

## Corrections traceability

- agent_one wrong → corrected: ACP stdio MCP gap; static model catalog; Bun as primary selector; API-key-only SDK auth; synchronous billed cost; "~200 LOC mechanical" overread of the testfake's scope.
- agent_two wrong → corrected: omission of `@cursor/sdk` entirely (the round-0 architecture section compared only ACP vs print mode); "null cost until observed" as a blanket stance.
- Both right independently: print mode unfit for production; conservative v1 declarations; Collaboration Mode exclusion; spike-gated commitment; managed-skills bridge reuse; no SQLite migration (with codec/contract-test work named).
