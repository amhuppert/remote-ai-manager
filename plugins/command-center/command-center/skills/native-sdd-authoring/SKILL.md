---
name: native-sdd-authoring
description: Author and review native Command Center specs and managed graph delivery workflows. Use when drafting, linting, proposing, revising, approving, planning, starting, capturing discoveries for, or amending a native spec through cctl spec and graph-workflow execution.
---

# Native SDD Authoring

## Reading specs without flooding context

Start with `cctl spec show <slug>`. Its default is a bounded nested outline with
stable handles, per-element state, and explicit omission metadata, which is the
navigation map for targeted `cctl spec get <slug>/<handle>` calls; get renders
complete line-oriented text by default and a named `element` envelope only
with `--json`. Use `--summary` when counts alone answer the question; its
disclosure reports zero returned rows, truncation by collection, and the exact
default-outline next command.

Use `cctl spec show <slug> --rendered` for the canonical current-revision
Markdown and `--full` for the complete JSON view. Both are file-backed: stdout
is a small artifact manifest, and `--json` serializes that same manifest rather
than widening the selected disclosure level or embedding the document. Read or
search the returned path progressively. If even a bounded summary or outline
would exceed the stdout budget, the CLI writes that exact inline envelope to a
JSON file and returns an artifact receipt with
`reason: "stdout_budget_exceeded"`.

Inline summary and outline show envelopes are flattened: `spec` is identity,
while view data such as `counts`, `requirements`, and `tasks` are sibling
fields. Artifact receipts instead carry `storage: "artifact"` and
`artifact: {path, format, bytes, sha256}`; rendered/full receipts also carry a
bounded `revision`. Status, lint, get, and section get keep named payloads under
`status`, `lint`, `element`, and `section`. Get also hoists
`elementId`/`kind`/`elementVersion`, so
identity never requires traversing the nested snapshot row. In a full show
artifact, `baseRevision` is the immediate parent named by the current revision's
`basedOnRevisionId`, `currentRevision` is the spec's latest revision regardless
of state, and `currentApprovedRevision` is the latest revision whose state is
approved. Inspect the offline field map and revision semantics with
`cctl spec schema read-envelopes`.

Every read answers from the current revision. A handle the current revision no
longer carries is refused with `historical_only` rather than answered from an
older one; the refusal names the revision that last held it and prints the exact
read. Reach for history deliberately with `--revision`, which takes a revision
number or a revision id, or not at all — so a handle you can read is a handle
the spec still has.

Sections are the one kind of content with no handle, so nothing addresses them
as `<slug>/<handle>`. The outline lists each one by element id, and
`cctl spec section get <slug> --id <element-id>` reads one in full: role, title,
body, position, and the `elementVersion` the next `cctl spec draft` of that
section must send.

## Exclusive Requirements and Design checkpoints

Requirements admits intent, requirements, and criteria only. Design admits the
design narrative and decisions only. Settle Requirements before entering
Design; do not author both stages in one revision or batch. To extend an
approved spec, open an amendment, author and approve the Requirements delta,
then advance into a separate Design draft. If the contract changes during
Design, run `cctl spec return-to-requirements <slug> --reason <why>`; this
withdraws the Design attempt and reopens from the latest approved Requirements
checkpoint without copying unapproved design choices backward.
Inspect stage and return-path contracts with `cctl spec status --help`,
`cctl spec return-to-requirements --help`, and `cctl spec schema guidance`.

## Managed delivery workflow

A delivery attempt (`cctl spec plan open <slug>`) owns one real project workflow definition. That definition is authored as an ordinary graph `plan.json` and written with `cctl workflow replace <definitionId>`, using the definition revision as its compare-and-swap token. What is specific to a spec delivery — the pinned revision, how criteria reach contexts, phase-scoped authoring, and the preflight that reports what would refuse a propose — is owned by the "Delivering a native spec" section of the graph-workflow-planning skill. Every receipt on this path names the act that follows it, so follow the hint rather than a sequence restated here. Workflow Builder is the human's review surface: the managed definition is reviewed there before sign-off, and pending reaffirmations are cleared there in one batch. The charter (mission, invariants, conventions, sources) is part of that same plan while the attempt is a draft — an `update-charter` op carries its fields at the top level of the operation, never nested under a `charter` key — and the server-owned pinned-spec, context-excerpt and claims sources are re-injected at propose, so leave them out of what you author. `cctl spec plan propose` freezes the charter into the candidate revision; `cctl spec plan reopen` clones an editable draft.

The version-4 binding contains dispositions only. Read it with `cctl spec plan get <slug>` and author criterion coverage in the linked workflow definition; the planning skill's "Delivering a native spec" section owns that contract. Keep payloads under `.cc/temp/`. Human disposition decisions stay on the review surface. Graph and binding revisions are independent; re-read the surface whose write was refused. Every unlaunched version-3 candidate must reopen, re-propose and receive fresh sign-off; historical snapshots remain readable.

Every open derives its scope from the delivery delta. A criterion the last delivery proved and nothing invalidated becomes `delivered_elsewhere`; one whose governing content moved becomes `pending_reaffirmation`; undelivered, hard-stale, and deferred criteria are selected again. Only a human clears pending reaffirmations, as one batch on that review surface, against the binding revision they read.

Write each launch context's graph acceptance criteria in the ordinary graph dialect: `acceptanceCriteria` is an ordered list of `{ "id", "statement", "covers"? }` records, ids kebab-case and unique within the context, one independently-failable obligation per record. Validators cite those ids in blocking issues, so a record is the unit a verdict can address. Prose is still accepted on the authored write paths and wraps as exactly one `ac-1` record — a migration affordance, not a second spelling, and one record holding a paragraph of obligations is the blob the records replaced. These are graph criteria, distinct from the spec's own pinned criteria that binding dispositions and coverage address. Criteria and charter invariants state outcomes only; process rules such as red-green TDD belong in the charter's `conventions`, because a validator cannot verify process on the finished candidate and would fail correct work for lacking proof.

Inspect the managed plan contract with `cctl spec schema guidance`.

## Stable-source claims and dynamic accountability

Proposal freezes coverage-derived claims against stable authored contexts. Dynamic contexts, expansion, must-run coverage and execution outcomes remain owned by graph semantics. Inspect the binding and lifecycle with `cctl spec plan get --help` and `cctl spec schema guidance`; proposal and sign-off also report the advisory review for the authored plan revision.

### Recovering claimant validation failures

Claim proof comes from the authored context's graph outcome, not from the merge
job's prepared-candidate validation. If delivery refuses an active claimant whose
required round is absent, open, or concluded without a passing outcome, repair or
resume the graph until that context is recertified. If the claimant belongs to an
archived execution, it cannot be recertified in place: obtain a current-revision
Studio waiver for the refused criterion or abandon and start a replacement
delivery execution. Re-running Merge validation alone cannot change native-SDD
claim proof. This guidance was earned by remote-ai-manager#8 (2026-08-22), where a
completed claimant retained a concluded/null round and every Merge retry was
therefore deterministic.

## Finalized proposal, sign-off, and one-off start

Review the managed definition and the binding with `cctl spec plan get` before proposing. `cctl spec plan propose <slug>` freezes the exact definition id, revision, definition hash, binding hash, candidate id, and candidate hash. A draft never has a candidate identity. A proposed definition is read-only; `cctl spec plan reopen <slug> --reason <why>` clones it to a new editable definition and preserves the frozen candidate as history.

Only a human can sign off. `cctl spec start <slug> --inputs .cc/temp/inputs.json` is the one-off start of an approved attempt; the file is the exact JSON object sent to the shared graph start boundary for ordinary input validation. `--park` is only prelaunch review and creates no execution. Read `cctl spec start --help` and `cctl spec schema guidance` before launch.

## Ordinary live edit, capture, and replacement

A running execution's working copy is edited through the ordinary `cctl workflow live edit` surface. It never changes the immutable approved candidate. Use `cctl spec capture` for discovered delivery work: without `--blocking-reason` it records follow-up work; with that reason it abandons the run and opens a replacement attempt. Before launch, edit a draft or reopen the proposed attempt instead of trying to capture work.

A pause is safe at any point after start, including before any lane has been provisioned: a run paused that early resumes into its first dispatch rather than stalling. The exit after an abandoned launch is `cctl spec plan open <slug>`, which opens the replacement attempt.

The version-3 transition is a one-way destructive cutover. Its
legacy-retirement boundary removes the embedded graph plan; do not retain or
reintroduce a parallel reader, compatibility branch, or alternate plan dialect.

Inspect lifecycle refusals and bounded file payloads with `cctl workflow live edit --help`, `cctl spec capture --help`, and `cctl spec schema guidance`.

## Removal and reintroduction symmetry

Remove draft elements by handle with `cctl spec remove`. When a surviving element refers to the target, update or remove both sides in one `cctl spec draft` batch so the transaction never leaves a dangling reference.

Treat removal as reversible history, not deletion. Reintroduce the same element id with `"reintroduceHistorical": true` and `"baseElementVersion": null`; this restores its original number and handle. Follow the exact recovery printed by the removal receipt.

Inspect both acts with `cctl spec remove --help`, `cctl spec draft --help`, and `cctl spec schema element-batch`. For the current lint and evidence reference, run `cctl spec schema guidance`.

## Correcting obsolete questions and assumptions

A question or assumption the spec has outgrown gets corrected, not left to rot. `cctl spec attention edit` rewrites an open question or a proposed assumption at the record version you last read. `cctl spec attention withdraw` retires an obsolete open record with a durable `--reason-file`. `cctl spec attention supersede` gives a disposed assumption one successor in the current amendment, preserving lineage instead of rewriting the decision a human made. `cctl spec attention cite` and `cctl spec attention uncite` change exactly which assumptions a draft element cites, at the citation version you read.

The division of labour is fixed: you correct the record, and the human answers a question and disposes an assumption. Answered, disposed, withdrawn, and superseded records are immutable history. Never answer or dispose on the user's behalf, and never open a question to hold work you should be authoring — record what you proceeded on with `cctl spec assume` and keep going.

Inspect the compare-and-swap tokens each verb takes with `cctl spec attention --help`. For the current lint and evidence reference, run `cctl spec schema guidance`.

## Withdraw-proposal vs dismiss-superseded

Use `cctl spec withdraw-proposal` only to take back a proposal authored by the current conversation before a human has acted. It ends that revision and opens its content as a follow-up draft for repair.

Use dismiss-superseded only for a stranded proposal that a later approved lineage forked past. This is a human act, records the superseding revision and reason, and opens no draft. Never substitute withdrawal when stale content must stay closed.

Reopening costs far less than a pending count suggests: approvals on unchanged subjects carry into the reopened draft under the same applicable gate, and only edited subjects need re-approval. `cctl spec status`, the propose and withdrawal receipts, and the Request Changes notice all print both sides of that ledger — satisfied, split into carried, current-revision, import-settled, and combined-act, beside pending — above the `carry rule:` line stating the mechanism. Price a repair round off that ledger rather than re-litigating settled content.

Inspect the distinct guards and outcomes with `cctl spec withdraw-proposal --help` and `cctl spec dismiss-superseded --help`. For the current lint and evidence reference, run `cctl spec schema guidance`.

## Element-id/handle/version semantics

Treat an element id as its globally unique, immutable identity — unique across every spec in the project, including abandoned ones, which keep their ids forever. Always prefix element ids with the spec slug (for example `my-spec-req-audit`) so no other spec can own yours first; a collision refuses with `element_id_taken` and the only recovery is a different id. Treat its handle, such as `R3.2` or `D4`, as the human address assigned within the spec and preserved when the same id is reintroduced. Use ids in typed references and handles in CLI addresses unless a schema says otherwise.

Treat `elementVersion` as a compare-and-swap token local to one revision. Versions restart when approved content is copied into a new amendment revision, so re-read every element before writing and never compare revisions by element version.

Because you mint element ids, one batch can create an element and cite it from a sibling's typed reference fields in the same write. Reference integrity is judged against the result of the whole batch rather than each item as it lands, so array order does not matter and a cross-reference never has to wait for a second call. Parentage is the exception to writability: `parentElementId` is fixed at creation, and an update naming a different parent is refused with `parent_immutable` — place content elsewhere by writing a new element under the parent you want and removing the old one.

Inspect the write contract with `cctl spec draft --help` and the relevant `cctl spec schema <document>` leaf. For the current lint and evidence reference, run `cctl spec schema guidance`.

## Importing a spec authored outside CC

Bring a spec authored outside CC in whole with `cctl spec import --file <bundle.json>`. The imported spec is born approved at design on import provenance: it records that an agent imported the content and from which source, and no approval of any kind is written, so every human gate on it stays as strong as on a spec authored here.

Run the act in one order. Check `cctl spec list` and `cctl spec search --all <query>` and stop if an existing spec already covers the work. Author the bundle from the source documents yourself: you are the parser, and the server never reads a source file. Iterate with `--dry-run` until it reports no blocking finding and prints the handles it would allocate, so bundle-local refs resolve against the real numbering. Then import once and read the receipt. Treat a refusal as unfinished work — nothing was written, so follow the named remedy and import again.

Import creates new specs only; change an existing spec with `cctl spec amend` instead. Import is never an approval shortcut for work authored here — content drafted in conversation earns its approval through `cctl spec propose` and human sign-off. Once the imported spec is ready, use its ordinary managed delivery lifecycle.

Author the bundle so a delivered import owes a human no review pass. `delivered` defaults to true and records external-delivery provenance rather than machine proof, which the delivery gate never reads; opt out with `"delivered": false` when the source carries no acceptance criterion to record delivery against. Import a question already answered when the source holds the answer, and import an assumption with its real disposition — confirmed included — when the source shows it held. Carrying a source's disposition across is provenance capture, not the human disposition act: disposing an assumption here stays a Spec Studio act, so never invent a disposition the source does not show. An import authored this way arrives with zero open review items.

Inspect the act with `cctl spec import --help` and its document with `cctl spec schema import-bundle`. For the current lint and evidence reference, run `cctl spec schema guidance`.

## Consistency sweep and `propose --notes` protocol

Before proposing, run `cctl spec lint`, repair its consistency findings, and sweep reference integrity, criterion coverage, stale handles, and vocabulary the revision claims to supersede. Re-run the mechanical sweep until it is clean.

Lint reads handle tokens in element prose as real references, so a renumbered or removed element cannot ship a wrong `R3.2` through a clean pass. To name a handle token literally without asserting a reference, mask it as code: an inline backtick span or a fenced block, both of which lint skips, as it does link destinations and autolinks. Four-space indented code is not masked, so use a fence there.

For every review repair round, write a bounded notes file that maps prior findings to dispositions, names changed elements, and states deliberate non-changes. Attach it with `cctl spec propose <slug> --notes <notes.md>` so the reviewer starts from the disposition and diff rather than reconstructing intent.

A successful propose files the gate-scoped approval request itself, so the human already has the entry. The receipt reports one outcome per consulted gate — filed, already filed, not needed, filed with notice delivery uncertain, or not filed — with the attention id the human's row carries. Do not re-file what it filed: `cctl spec request-approval` is the recovery for the last two outcomes only, and the receipt prints it as the next command when one occurs.

Inspect the loop with `cctl spec lint --help`, `cctl spec diff --help`, and `cctl spec propose --help`. For the current lint and evidence reference, run `cctl spec schema guidance`.

## Finding classes and bounded terminal rounds

Classify each review finding as `new_risk`, `regression`, or `consistency_drift`. Repair consistency drift and run the mechanical pass before requesting another judgment round. Review any semantic repair only over its bounded changed surface.

Call a round terminal only when every consistency finding is repaired, the mechanical pass is clean, no new-risk or regression finding remains, and the repair diff contains no semantic expansion. A semantic expansion always receives another bounded changed-surface review.

Inspect the current lint and diff surfaces with `cctl spec lint --help` and `cctl spec diff --help`. For the current lint and evidence reference, run `cctl spec schema guidance`.

## Designed friction versus a defect

Parts of this surface resist you on purpose. Staged authoring, human-only acts, the withdraw-after-engagement guard, frozen revisions, stable handles, immutable parents, and strict validation-strategy rules are the product working: each protects a human judgment or an audit property that would be worth nothing if an agent could route around it. Absorb that friction, follow the refusal's named next act, and read the `why:` line a designed-constraint refusal prints — it states the rule rather than apologising for it.

The rest is not the product. A read path that answers the wrong question, a message that names no recovery, a verb that does not exist, or a refusal you cannot act on is a defect: report it to the user plainly instead of inventing a workaround around it.

Three constraints on the delivery path are worth naming in advance, because each is met as a refusal that reads like a missing capability:

| Constraint | What it protects | Where its reason renders |
|---|---|---|
| Must-run coverage lock | a skipped branch can never silently waive a claimed criterion | the `binding/selected-criterion-not-must-run` finding, which carries both the reason and the act that clears it |
| `requires-pause` for structural live edits | no lane reads a half-applied definition, because the batch lands as one definition swap | the `requires-pause` live-edit refusal |
| Provenance locks on a draft's `/origin` and `/approvalRequired` | what a signed candidate can prove about where it came from | the draft-stage `region_locked` refusal, which names the locked path and tells you to omit it; replace merges around the locks rather than refusing the write |

That last row is the one most often misread as a wall. Replace merges around those locks: a plan for a managed draft omits `origin`, `approvalRequired` and `lockedRegions`, and the two injected sources `native-sdd-pinned-spec` and `native-sdd-claims`, and the server fills them from the stored draft.

The heuristic: friction protecting a human judgment or an audit property is designed, so absorb it; friction in a read path, a message, or a missing verb is incidental, so report it. For the current lint and evidence reference, run `cctl spec schema guidance`.

## Notify only from success receipts

Notify the user that an act completed only after its success receipt proves the durable transition occurred. Treat a refusal, redirect, partial-progress receipt, or transport ambiguity as unfinished work: follow the named remedy, then notify only from the eventual success receipt.

Use `cctl <command> --help` when a receipt redirects the flow, and use `cctl spec status --help` to re-read durable state. For the current lint and evidence reference, run `cctl spec schema guidance`.
