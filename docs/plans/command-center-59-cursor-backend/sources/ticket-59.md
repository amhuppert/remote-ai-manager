# Ticket command-center#59 — Add Cursor as a third agent backend

- Status: `not_started`
- Type: `feature`
- Created: `2026-08-12T18:09:57.292Z`
- Updated: `2026-08-12T18:10:59.812Z`

## Summary

Dual-agent collaboration research (2026-08-12, run `304f213f`, branch `csm/cursor-spike-7ee15b`) concluded: **adding Cursor as a third agent backend is feasible and recommended, gated on a 2–4 day authenticated spike.**

| Level | Estimate |
| --- | --- |
| Decision spike (transport bake-off) | 2–4 days |
| Interactive Cursor conversations | ~3 weeks cumulative |
| Production scoped backend | 4–6 weeks cumulative ±30% |
| Full parity | Vendor-gated, not schedulable |
| Collaboration Mode | Out of scope (decision D19) |

Secondary size signal: ~9,000–13,000 LOC including tests (Codex adapter = 8,966 LOC as calibration floor).

## Key converged decisions

- **Transport is decided by a spike bake-off**, not pre-committed: a per-conversation **isolated `@cursor/sdk` worker** (Node child, `CC_*` env fixed at spawn — an inline SDK loop in the CC server is ineligible because concurrent conversations need distinct credential-bearing environments) vs a per-conversation **ACP child** (`agent acp`, stdio JSON-RPC). Print-mode NDJSON is a last-resort fallback only. Decision weights: env isolation + process lifecycle first; Bun compatibility is just a packaging check.
- **ACP stdio MCP is v1 baseline** (the probe's `{http, sse}` flags advertise the optional transports, not the absence of stdio).
- **Models:** no static curated catalog (account/team-specific; Cursor says "discover, don't hard-code"). MVP = proven default + validated custom-ID flow; production = explicitly-scoped async catalog seam extension. No `cursorFastMode` — generalize the leaked `codexFastMode` field instead.
- **Cost:** report token usage synchronously; `costUsd` only when settled and correlated, else null. No token-based estimation (Cursor pricing is plan-based).
- **Scope:** MVP registers the conversation facet only. Task facet lands in the production phase behind an explicit eligibility gate restricting Cursor to nongoverned task profiles (enforced at selection, not documentation).
- **v1 declarations:** `post_validation` structured output; synthetic/unsupported fork; next-turn queueing; no external turns; `fsWriteRestriction: "unsupported"` (bars validator/confined roles until proven); conversations at Codex-equivalent first-turn instruction fidelity.
- **Managed skills:** generalize the Codex `.agents/skills` symlink bridge — Cursor discovers that directory natively, including headless.

## Vendor gates (parity blockers, independent)

1. **Privileged instruction channel** — neither the SDK nor ACP documents a system/developer channel above user priority. Blocks governed tasks / validators / charter governance until Cursor ships one. Engineering time cannot manufacture this.
2. **Exact filesystem confinement** — sandbox machinery exists (Seatbelt on macOS, Landlock/seccomp on Linux, allow/readonly paths), but CC's `fsWriteRestriction: "enforced"` claim requires an adversarial suite (direct writes, shell writes, symlink escape, temp paths, nested processes, deny precedence) per platform.

If both pass: ~1–2 further weeks to enable the remaining declarations.

## First implementation steps

1. **Standalone early fix:** `src/lib/commands/route-handlers.ts:66-68,115-117` silently maps every non-Codex backend to Claude — must become schema validation **before** a third backend id exists.
2. **Run the spike** (10-item exit criteria in the final-answer attachment). Requires an authenticated Cursor account.

## Facts worth keeping

- `@cursor/sdk` verified on npm: v1.0.27, `engines.node >=22.13`, published 2026-08-06. Docs warn "tool call schema is not stable". SDK credential store (`Cursor.auth.login()`) does not reuse CLI/desktop login.
- CLI binary is `agent` (legacy alias `cursor-agent`; distinct from the editor's `cursor`), build `2026.08.11-e8db854` at research time, auto-updating date+hash versions — pin a minimum-tested version; enterprise admins can disable headless (preflight must detect).
- ACP probe: v1 negotiated, `loadSession: true`, **no** `session/resume` — continuation replays via `session/load`.
- Seam readiness is CI-proven (574-LOC testfake third backend through the consumer-locality suite); no SQLite migration needed, but session-ref codec arms + repo round-trip contract tests need extension.
- No prior Cursor work exists in repo/specs; only prior art is the 2026-06-21 competitive-landscape report.

Full detail is in the attachments: final answer, negotiation audit, both round-0 research drafts, and the research conversation snapshot.
