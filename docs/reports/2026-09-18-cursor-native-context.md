# Cursor native context telemetry — command-center#121

SDK baseline: `@cursor/sdk` 1.0.31, local runtime, audited 2026-09-18.

## Shipped behavior

Cursor stays usable with unknown context occupancy and maximum. Billing input,
cache, cumulative, and output counts never become occupancy measurements.
`contextWindowMetrics` remains false and turn context fields remain null. The UI
shows **Context unknown** instead of hiding the measurement; workflow context
limit hints disclose that numeric thresholds require occupancy measurements.

A top-level public `SDKTaskMessage` containing a native summary becomes a durable
conversation notice. The original SDK message remains losslessly stored under
`raw`, with the existing run/event identity providing exactly-once persistence.
It does not become assistant answer text. A summary observed this turn sets
neutral `compacted` even if the turn subsequently fails or is cancelled. Later
turns and recreated runtimes start with no observation; stored notices survive
transcript reload.

This is a conservative context invalidation signal. It confirms that the provider
produced a native summary, **not** successful context replacement or its precise
start/end timing. The notice states this limitation. Existing memory-index reset
and workflow result paths consume the neutral signal. The live compaction registry
also makes it available to mid-turn task completion, and is cleared at turn end.
A configured context-limit
policy now rotates after observed native compaction even when occupancy cannot
be measured; with no limit configured it remains disabled. Sticky rotation
survives SQLite reload. Cursor and Codex both benefit from this neutral gate fix.

## Provider provenance and gaps

Installed declaration paths below are relative to `node_modules/@cursor/sdk/`.

- `dist/esm/usage-types.d.ts` documents `TokenUsage` as per-turn or cumulative
  token counts. `RunResult.usage` and agent usage are billing totals.
- `dist/esm/options.d.ts` model definitions expose no effective window maximum.
  Opaque checkpoint blobs are not a supported context-metrics API.
- `dist/esm/messages.d.ts` exports `SDKTaskMessage`. In this pinned local SDK,
  the only task-message constructor in `dist/esm/index.js` maps a native
  `summary` update to `{type:"task", agent_id, run_id, text: summary}`. Nested
  agent tasks instead travel in tool messages and task deltas; those do not
  invalidate the parent context.
- `dist/esm/vendor/cursor-sdk-shared/delta-types.d.ts` declares `summary`,
  `summary-started`, and `summary-completed`. However, the installed
  `ConversationAccumulator` suppresses all three before invoking public
  `onDelta`; `Run.stream()` maps only the summary text. The converter also omits
  the internal completion failure flag. Wiring the declared callback would not
  provide actual start/completion telemetry.
- The provider's [preCompact hook documentation](https://cursor.com/docs/agent/hooks)
  specifies genuine pre-compaction `context_tokens` and `context_window_size`.
  The SDK has no public hook callback or hook-path option: integration requires
  filesystem hook configuration and enabling ambient setting layers. This
  supplies neither ordinary-turn nor post-compaction freshness and has no
  completion hook. CC does not change workspace/user settings to claim current
  occupancy from that one-time sample.

Unblock conditions: a supported provider field/callback reporting current
occupancy and effective maximum with defined freshness after compaction and
resume; delivered lifecycle events including failure/cancellation and the point
at which replacement takes effect; durable event identity or replay support for
reconstructing events missed while detached. These are improvement opportunities,
not admission blockers for Cursor workflows.

## Validation and limits

Registered behavior tests reproduce and cover native-summary observation,
malformed/nested/assistant-authored false positives, duplicate delivery,
failed/cancelled turns, transcript reload, per-turn reset and resumed runtimes.
The context-limit gate and full-composition SQLite lane tests cover rotation
without fabricated measurements, no-policy behavior and restart durability.
The unknown-context indicator test distinguishes unknown from measured zero.

An authenticated bounded SDK probe ran 10 successful turns, including six large
ledger inputs (2,295,328 total prompt bytes), then reread provider state in a
separate process: 10 finished runs, 229 durable events and a checkpoint. A fresh
process resumed the agent and recalled the marker and secret number. Usage was
reported but was not treated as occupancy.

**No public native-summary or summary lifecycle event was observed during that
probe.** A billing input-count decrease does not prove compaction. The positive
summary mapping is supported by the pinned SDK implementation and injected-seam
behavior tests, not positive authenticated event evidence. Exact native
compaction timing/completion and numeric threshold enforcement remain unsupported.

Private diagnostic scripts, raw non-user SDK envelopes, provider-store readback,
credential-scan results and digests are retained under
`.cc/temp/cursor-context-probe/`. The probe is a bounded SDK diagnostic because
`cursor-acceptance` is not registered in this environment; registered `test`
excludes that live project. No mock establishes any provider guarantee.


A second authenticated diagnostic exercised the branch-built production worker,
supervisor and `CursorConversationRuntime` on create and fresh-process resume.
Both results retained null occupancy/max and real token usage. The same persisted
provider ref resumed correctly; the production transcript reader reloaded four
visible messages from 48 durable lines, including 46 native envelopes. No summary
was observed here either. Receipts, source/bundle hashes and credential scan are
under `.cc/temp/cursor-runtime-probe/`; all workers were closed.

Visual inspection in the session Storybook covered the unknown indicator and
measured 25% state at desktop/390px widths, plus the session information strip at
1440px/429px. Hover and keyboard focus reveal the disclosure; Escape dismisses
it; no clipping/overflow was found. Screenshots are retained in
`.cc/temp/context-*.png` and `.cc/temp/strip-unknown-cursor*.png`.

Final registered checks passed: format, lint, full-project typecheck and seams.
Thirteen focused test files passed across runtime, projection, UI, lane service,
mid-turn gating and SQLite continuity. All scoped runs required file matches.

| Check | Passing run |
| --- | --- |
| Cursor behavior, including live registry and archive failure | `vrun-ee1f6de8-2cbe-4ae4-aba1-14a538a437cc` |
| Mid-turn completion gate | `vrun-99afbb28-ce91-4122-8544-b834a473c762` |
| Context-limit decision | `vrun-0ff45968-8415-459d-a670-06fe35e80967` |
| SQLite rotation continuity | `vrun-36ebbac6-c723-48fc-a056-28ef88aa6223` |
| Runtime/projection/lane regressions (4 files) | `vrun-ebcd0fed-e183-4259-82f0-c343a4451f56` |
| UI consumer regressions (4 files) | `vrun-950011a2-2ee0-4a13-a921-6f7fa39eaf90` |
| Unknown-context indicator | `vrun-042a2cdb-742e-44cb-8b2c-4575c194ee7c` |
| Typecheck | `vrun-f03a1350-b3ad-400b-bd12-f369f248c2a6` |
| Seams | `vrun-aa1cf417-7d40-4340-858a-1c85d588e41f` |
| Lint | `vrun-89405a4b-06bb-4954-86ba-f9419ad6dac1` |
| Format | `vrun-1bfc647a-966f-4bf1-a427-0cb2e612f1e0` |

Long-context evidence SHA-256:

- Native envelopes: `5e4d55b98cd6f01b91edd259d974f1fd719cd8e6acba75bc6cf4be765143b066`.
- Independent provider-store read: `dc0d50658d959e9905ca2021c3dcefb05b68d34f8ada95e1bfb78be1e3b4bc99`.
