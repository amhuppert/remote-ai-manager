# Codex checkpoint enablement

Date: 2026-09-09. Ticket: command-center#129, items 1–2. Base revision: `563c86480`.

Codex checkpoint admission is enabled after the existing real continuation probe passed in session and project scope with **GPT-6 Astra, high reasoning, fast=false**. Both runs passed all nine independently authored continuity expectations, three fresh checkpoint continuations, and queued delivery. The shared runtime, seed generator, prompt framing and evaluation expectations are unchanged.

## Earlier failure and scope of the evidence

The original release report remains a historical record: cert4's Codex session run answered Unknown for RCN-4417 although the frozen seed reportedly contained it. Its protected artifacts were not present in this session worktree, so that exact input could not be replayed. The committed original-conversation corpus and unchanged probe were used for fresh, explicitly pinned runs. Both answered RCN-4417 correctly; no production defect was reproduced and no recall fix is claimed. One full run per scope was selected before execution; there were no discarded quality failures or retries to select a passing sample.

Two additional startup probes using CC's configured default, GPT-5.4/high, each received HTTP 400: that model is not supported with this ChatGPT account. Both stopped before checkpoint generation. They are environment refusals, not passing checkpoint tests. Defaults and model admission are unchanged. Certification establishes the Codex adapter contract with the named model, not perfect recall across every model or conversation.

## Live continuation and durable audit

Run commands (each uses a separate scratch datastore and project under `.cc/temp`):

```sh
scripts/probes/run-checkpoint-continuation.sh --backend codex --scope session --run-id enable-baseline --model gpt-6-astra --reasoning high
scripts/probes/run-checkpoint-continuation.sh --backend codex --scope project --run-id enable-baseline --model gpt-6-astra --reasoning high
```

The probe temporarily enables the descriptor inside its isolated process to test a disabled capability. Both reports explicitly record `shipped=false, overridden=true`. The production descriptor was enabled only after both reports passed and their durable rows were audited.

| Scope | Independent expectations | Seed UTF-8 bytes, cycles 1 / 2 / 3 | Ordinary-turn cost (CC estimate) |
| --- | --- | --- | --- |
| session | 9/9 | 6551 / 7725 / 9990 | $0.539346 |
| project | 9/9 | 8823 / 8144 / 9423 | $0.474830 |

Each run made 10 ordinary Codex calls and six Claude compaction calls, within the probe's fixed 12/6 ceiling. Ordinary costs use `cc:estimateCodexCostUsd`; compaction cost and provider occupancy remain unavailable. Seed sizes are exact bytes, not a context-percentage or savings claim.

Independent read-only SQLite inspection confirmed three applied operations per scope, distinct fresh accepted references, matching delivery/acceptance attempt IDs, exact seed SHA-256 hashes and byte counts, and the cycle-two queued-attempt/message correlation. The original assistant transcript contains the RCN-4417 answer with the memory witness. The production probe also checks seed omission after first delivery, memory redelivery, original archive/image preservation, and artifact-generation independence. The image check recovers original bytes and reattaches them; it does not claim autonomous model-driven history-tool use. The queued probe case enqueues after readiness, not during generation.

Public report SHA-256 values:

- `enable-baseline-project`: `afb971a0ed777e5e1e13286d27770dacc5521390a82ab1aa3fe3e6b766cbdab4`
- `enable-baseline-session`: `6d151a18fc4561ff88076a698b76f457a5baab181ec49d4daf2f3633f0b72649`

Protected evidence and SQLite state are retained locally under `.cc/temp/checkpoint-probes/codex/<run-id>/`; public audit results are under `.cc/temp/codex-enablement/audit.json`. Provider references and seed text are excluded from this report.

## Product verification and registered checks

The session-scoped dev server served this worktree at the URL returned by `cctl dev ensure`. Its config/database were created inside this worktree's `.config`, discovering only the scratch project under `.cc/temp/codex-enablement/projects`. Next.js MCP confirmed the implementing worktree. The source-built CLI and restarted server used build `563c86480-2026-09-09T15:37:47.435Z`; restarting was required to refresh the process-owned backend registry after the descriptor edit.

Before enablement, both the real CLI preflight and the session UI refused the action with `backend_unsupported`. After enablement and restart, preflight returned eligible and the UI action became executable. The session checkpoint was created by clicking **Compact context now**. The project checkpoint was created by the source-built `conversation compact-context <id> --project checkpoint-browser --wait` command, which returned **ready**, not applied. Both next ordinary Codex turns applied their checkpoint and correctly recalled all seven fixture facts. Both UI hosts displayed **Checkpoint applied**.

| Scope | Operation | Frozen bytes | Accepted seed SHA-256 |
| --- | --- | --- | --- |
| session | `791d9c28-ccf4-4323-8263-6c5ab0e65d7a` | 3085 | `ccb78e6daadffe01f650a5970181d84808059cdcfe7e57b37a2d4016e8520538` |
| project | `d210b705-b41e-470b-925f-8e8be4731d94` | 2849 | `4e405eaee8e285daeb53eb1f6ec01eb867ae374a4afe3f3815b149c27c628339` |

SQLite read-back confirmed fresh accepted references, matching attempt IDs and seed hashes, and exactly two ordinary user turns per fixture. Saved-handoff viewing and original archive-outline navigation did not add an ordinary turn. The source-built CLI retrieved the applied receipts and original history. A direct fixture prompt attempted during building was refused before delivery; the same request was accepted after ready. This was not a UI queue test. The queue evidence is the separate three-cycle probe and the passing maintenance integration tests.

Next.js reported no configuration or runtime errors after both UI journeys. Local evidence includes `product-audit.json`, both applied receipts, the disabled/enabled preflights, and browser snapshots under `.cc/temp/codex-enablement/`. The isolated dev server and test browser tabs were stopped after verification. Scratch fixtures and protected probe evidence are retained locally for reproduction; no production datastore was used.

The behavior-level admission regression first failed with `backend_unsupported` (one failing assertion, 50 existing passing tests), then passed after the descriptor change. No provider runtime or prompt behavior changed. Registered verdicts, read from the JSON envelopes:

| Check | Scope | Verdict | Run ID |
| --- | --- | --- | --- |
| Admission reproduction | one file | Expected failure | `vrun-86d81c0b-cfa3-457d-a5f4-057853e0d66e` |
| Admission regression | one file | Passed | `vrun-d41e227f-bed3-4787-91f0-61863ce96e3a` |
| Format | changed | Passed | `vrun-33d42ff3-5403-49b5-9641-7e334b1c29a8` |
| Lint | changed | Passed | `vrun-b75530ee-e485-461d-b811-98aa0bcf9051` |
| Typecheck | full | Passed | `vrun-7e393614-e80b-4378-a1a9-38a0eacf2ed8` |
| Seams | full | Passed | `vrun-79ad90ff-6ab0-4354-aefb-45485a7163f6` |
| Runtime/checkpoint regressions | six matched files | Passed | `vrun-06b1a350-3f2f-41ca-bf7c-d3198da3fd4f` |

The six regression files cover Codex's real runtime implementation with injected transport, shipped-capability admission, checkpoint delivery, recovery, restart and maintenance. The complete project test suite was not rerun for this descriptor-only production change; its original release verdict remains in verification.md. Existing structured lifecycle diagnostics continue to record admission, fresh runtime creation and acceptance without adding seed text or provider references to public logs.

## Remaining ticket scope

Cursor remains disabled. Ticket items 3 (current-work refresh), 5 (checkpoint-seeded forks), and 7 (optional agent handoff) remain open. This change adds no automatic checkpoint triggers, SDK changes, provider-native compaction, or changes to workflow-owned admission.
