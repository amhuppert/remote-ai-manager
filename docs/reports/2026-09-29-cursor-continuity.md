# Cursor continuity — command-center#165

Baseline: `@cursor/sdk` **1.0.31**, local runtime, `composer-2.5` with
`fast=false`, macOS, 2026-09-29. Published **1.0.32** was also assessed: its
agent, run, options, checkpoint and local-store declarations are byte-identical
in the relevant APIs. No dependency upgrade was justified by this ticket.

## Provider support and native fork gap

The supported continuation operation is
`Agent.resume(agentId, { local: { cwd, store }, ...options })`. It resumes the
same agent's latest state. `Agent.create` creates a fresh agent. Neither accepts
a source checkpoint, run or message anchor, and `SDKAgent` exposes no fork or
clone method. Inline MCP servers and non-persisted tool settings must be supplied
again on resume.

The SDK exports `LocalAgentStore` and checkpoint references on agent/run rows.
These are persistence interfaces, not a documented branching contract:
`AgentCheckpointStore.loadLatest(agentId)` has no historical selector;
`saveCheckpoint` accepts an opaque SDK object. The public contract does not
specify graph completeness, historical retention, checkpoint commit timing or
identity remapping. A checkpoint root alone does not establish a safe fork.

Sources:

- [Cursor TypeScript SDK](https://cursor.com/docs/sdk/typescript.md), especially
  “Resuming agents”, “Conversation context”, “Local agent stores”, “Custom
  stores”, and “Known limitations”.
- Installed declarations under `@cursor/sdk/dist/esm/`: `stubs.d.ts`,
  `agent.d.ts`, `options.d.ts`, `run-store-public-types.d.ts`, and
  `store/local-agent-store.d.ts`.
- [Published 1.0.32](https://registry.npmjs.org/@cursor/sdk/-/sdk-1.0.32.tgz).
  The public changelog still ends at 1.0.31; API equality is not a claim of
  runtime equality. Only 1.0.31 ran authenticated turns here.

### Authenticated storage-transplant experiment

An isolated diagnostic used only exported store methods to copy all blobs saved
at a completed source turn into a separately created agent's store. It then
replaced the target's latest checkpoint and SDK-owned metadata with the source
snapshot, disposed the target and resumed it. No transcript seed was sent.

The experiment establishes more than model recall:

- Source and target agent IDs differ, and streamed target envelopes carry the
  target ID.
- The source's first and second turns have different checkpoint roots. The
  target receives the first root; public message readback includes marker A and
  excludes later marker B.
- The fork recalls A and excludes B. Its turn leaves the source agent row
  byte-equivalent after canonical serialization.
- A separate Node process resumes both stores. The source recalls A and B; the
  fork recalls A and excludes B.

Two preliminary attempts exposed lifecycle details: disposing an unused
`Agent.create` leaves its reserved queued run, making a later send fail with
“already has active run”; independent stores can already contain identical blob
IDs, so copying must account for content-addressed duplicates. The successful
experiment first settled the target's initial run and reused identical bytes.

This is **experimental native-state transplantation**, not a shipped native
fork. It requires deliberately replacing SDK-owned metadata, including its blob
encryption metadata, and manually constructing a state/identity relationship
that Cursor does not document as supported. Passing this bounded experiment
does not establish a safe public branching contract or arbitrary message-level
anchors. The native-fork gap remains open. A supported fork/restore API, or an
explicit provider contract for this store operation, would unblock it.

Private scripts, raw envelopes, source/target stores and restart evidence are
under `.cc/temp/cursor-store-fork-probe-v3/`; raw SDK state is not published.

## CC continuity mechanisms

Ordinary forks retain the existing accurately labeled **synthetic** mechanism:
a new agent and per-conversation store receive at most 24,000 characters of
visible transcript text, bounded inclusively by the selected CC message. Later
source messages are excluded. Images, hidden provider state and tool internals
are not inherited. The source provider agent is neither resumed nor modified by
fork creation.

CC checkpoints use the existing backend-neutral continuation-document flow.
Their immutable seed, hash, source boundary, provenance and optional advisory
handoff live in SQLite. Continuing a checkpoint retires the old runtime and
starts a fresh agent with the saved seed once. A checkpoint fork copies that
saved document into an independently owned conversation. These are **CC
checkpoints**, not Cursor provider-state snapshots. The optional handoff is
separate from the checkpoint's source evidence and from an ordinary synthetic
fork seed.

## Anchor and policy guarantees

| Operation | Anchor / fidelity | Identity and policy |
| --- | --- | --- |
| Ordinary resume | Latest durable state of the same Cursor agent | Same opaque reference and per-conversation store; supervised worker reapplies cwd, model selection, tools, MCP and capability delivery. |
| Ordinary fork | Selected CC message, inclusive; bounded visible text only | New agent/store and independently resolved launch configuration; existing synthetic provenance is retained. |
| CC checkpoint | Recorded CC source boundary frozen when the checkpoint is built | Immutable SQLite seed/hash/provenance; next prompt retires the source runtime and creates a fresh agent. |
| CC checkpoint fork | Selected saved continuation document; later source turns excluded | Independent conversation, fresh reference, saved checkpoint lineage; optional handoff inclusion is explicit. |
| Agent handoff | One extra turn on the source's latest state, not a historical provider anchor | Same source reference, isolated tool-disabled worker, no added repeatable instructions, MCP, custom agents or question tools. Ordinary settings are reapplied on subsequent resume. |
| Native provider-state fork | No supported anchor selector in the assessed API | Experimental blob/metadata transplant passed bounded checks but is not a supported production guarantee. |

Checkpoint creation remains available independently of optional capture. Handoff
text is advisory and stored separately, never promoted to source evidence or
used as an ordinary fork's transcript seed. Existing lifecycle admission,
budgets, cancellation and holds apply. Failed worker collection rejects owned
close, including repeated reconciliation, so it cannot falsely release a hold.

## Authenticated verification

All probes used isolated databases/stores inside this worktree's `.cc/temp`,
real Cursor authentication, and production services/supervised workers except
the explicitly experimental direct-SDK store probe. The account accepts
`composer-2.5`; its usage API returns `403 feature_unavailable`, so no billed
cost guarantee is made. The SDK's existing platform, credential, cwd and model
preflight restrictions remain in force.

### Checkpoint continuation and queued delivery

Ran the production-manager probe in **both session and project scopes**, three
checkpoint cycles per scope, including queued delivery in cycle two:

```sh
scripts/probes/run-checkpoint-continuation.sh --backend cursor --scope session --model composer-2.5 --run-id ticket165-certified --compaction-call-budget 18
scripts/probes/run-checkpoint-continuation.sh --backend cursor --scope project --model composer-2.5 --run-id ticket165-certified --compaction-call-budget 18
```

Both lifecycle reports passed with no structural failures. Each used 10 ordinary
and 12 compaction calls, and satisfied **9/9 continuation expectations**,
including source-memory identifiers, image evidence and queued-question answers.
The production paths stored and consumed checkpoint seeds with durable receipts.

Two harness issues were exposed, not hidden by a rerun: the old six-call
compaction budget no longer fits three work/format cycles, and the raw queued
answer reader mistook Cursor's last text delta (`witness`) for the whole answer.
The initial grading output therefore reported 7/9. Regrading the same persisted
transcripts with the production message parser yielded 9/9 in both scopes;
original outputs and corrected answers are retained. The committed probe now
uses that parser, with a failing-then-passing streamed-answer regression, and
accepts a bounded explicit call-budget override (default unchanged).

Evidence roots:
`.cc/temp/checkpoint-probes/cursor/ticket165-certified-session/` and
`ticket165-certified-project/`, including `evidence/protected-evidence.json`,
`public-report.json` and `evidence/corrected-queued-grade.json`.

### Historical checkpoint fork and process restart

An additional production-service probe saved a checkpoint, continued the source
with a unique post-checkpoint marker, forked the saved checkpoint, exited, then
resumed the fork in a separate Node process. Checks all passed: saved seed/hash
stable, source row unchanged by fork, independent provider references, historical
identifier `RCN-4417` recalled, and later source marker excluded. SQLite reload
retained the checkpoint lineage and fork receipt. This proves the CC document
mechanism, not native provider inheritance.

Evidence: `.cc/temp/checkpoint-probes/cursor/ticket165-baseline2-session/fork-live-result.json`.

### Handoff, tool control and cancellation

The authenticated capture control first used an ordinary source turn to create
a file through a real shell tool. It then resumed the same reference with the
isolated tool-disabled profile, requested a second file and a handoff containing
a source-only marker, and resumed ordinarily afterward. All controls passed:
first file exists, capture file absent, handoff contains the marker, collection
settled, no prohibited native activity, same reference retained, and ordinary
shell tools restored. Native envelopes were archived and inspected, not inferred
from the answer alone.

A second capture was cancelled on its first native frame. It returned
`cancelled`, no candidate, `executionSettled=true`, and the same source reference.
A subsequent ordinary turn recalled the source marker. No worker hold remained.
Evidence: `.cc/temp/cursor-handoff-live-fixed/evidence.json` and
`.cc/temp/cursor-handoff-live-cancel/evidence.json`.

Live testing exposed an inspection-budget bug: elapsed model time between native
frames was being charged as inspection work. A reproduction with delayed frames
failed first; inspection now counts processing/archival time, while the separate
execution deadline bounds model latency. The live success and cancellation
controls were then repeated successfully.

### Review disposition

The independent adversarial review identified one valid high-severity finding:
failed worker collection returned a fulfilled cached close promise, allowing a
later lifecycle reconciliation to falsely attest cleanup. Accepted and fixed
with the smallest owner-contract change: close rejects persistently when
collection failed. A consumer-level regression now exercises managed ownership,
reconciliation and retained registration. Red run
`vrun-6a4d5715-865b-4109-9030-a14ab6e5b492`; green
`vrun-bcc4ccc0-124d-46c3-8408-98704d9d0fb5`.


### Existing application surfaces

The isolated session dev server served this worktree on port 3002. In the browser,
a Cursor source conversation was created, then survived a server restart before
**Compact with agent handoff** was used. The existing confirmation disclosed the
tool-disabled mode and limits. Checkpoint `e929f9c5-9d3c-4c9a-8cf9-efc6a7563004`
became ready with a 5,477-byte seed, two generation passes, and an included
908-byte handoff. Capture had complete native/transport coverage, no observed
prohibited activity, settled execution, and 58,153 inspected native bytes.
Checkpoint generation used the instance's configured compaction assignment;
the source capture and fork continuation ran on Cursor.

**Fork from this checkpoint** created conversation
`7f45ff13-98df-4a38-bec4-dc996fccd11f`, retaining Cursor / Composer 2.5 and the
source seed hash and boundary. Its first turn answered `CURSOR-CHECKPOINT-165`,
the UI showed **Accepted** and **Checkpoint applied**, and the saved conversation
had a newly issued Cursor reference. The source prompt count stayed at one.
The source's reference was already retired by checkpoint creation, as intended.
Screenshots were inspected; the receipt and lineage were read back through the
dev API. The temporary session/worktree was deleted after verification.

Private browser evidence: `.cc/temp/ui-checkpoint-api.json`,
`.cc/temp/ui-session-final.json`, `.cc/temp/ui-fork-result.txt`,
`.cc/temp/cursor-checkpoint-handoff.png` and
`.cc/temp/cursor-checkpoint-fork.png`.

### Registered checks

All scoped test commands required at least one matched file. Cursor runtime,
capability catalog/descriptor, capture, checkpoint selection, SQLite fork and
queued delivery, neutral capture lifecycle, Claude/Codex adapters, and the
streamed-answer probe regression passed. Parity documentation consistency passed
after regenerating its fenced sections. Relevant run receipts:

| Check | Passing run |
| --- | --- |
| Capture cleanup regression | `vrun-bcc4ccc0-124d-46c3-8408-98704d9d0fb5` |
| Cross-backend and checkpoint regressions (7 files) | `vrun-efabb979-e278-4057-ad2a-fc9088727df4` |
| Parity matrix and documentation | `vrun-b252548b-8dad-4990-87d5-2aaf7d4c3ee0` |
| Full typecheck | `vrun-cbc9b203-21c0-490a-97bc-aea02f144664` |
| Lint | `vrun-8a3bf931-eb7f-48a3-9ae8-1044cbb0d4f4` |
| Architecture seams | `vrun-6d7e705e-b834-4926-bb7b-a2f81ac8b414` |
| Formatting | `vrun-6d8c26b4-f58b-48b5-a2dd-4420eced5650` |

The combined earlier run `vrun-207020ef-77d1-4577-a383-33eb39754ea3`
passed catalog, descriptor, ordinary Cursor runtime and capture tests; its only
failures were the three documentation assertions before regeneration. The
separate parity run above resolves those failures. No native-fork acceptance is
claimed by these passes.
