---
name: native-sdd-authoring
description: Author and review native Command Center requirements and design specs. Use when drafting, linting, proposing, revising, preparing human approval, or amending a native spec through cctl spec.
---

# Native SDD Authoring

Read `cctl spec --help` and the relevant leaf help before authoring payloads.
Use `cctl spec schema guidance` for the current lint and evidence contract.

## Reading specs without flooding context

Start with `cctl spec show <slug>`. Its default is a bounded nested outline with
stable handles, per-element state, and explicit omission metadata, which is the
navigation map for targeted `cctl spec get <slug>/<handle>` calls; get renders
complete line-oriented text by default and `payload.data.element` only
with `--json`. Use `--summary` when counts alone answer the question; its
disclosure reports zero returned rows, truncation by collection, and the exact
default-outline next command.

Use `cctl spec show <slug> --rendered` for canonical current-revision Markdown
and `--full` for the complete JSON view. Both return artifact receipts with
`payload.kind: "artifact"`, bounded `payload.summary`, and `payload.artifact`
metadata; `--out <path>` chooses the destination. Read or search the file
progressively. JSON artifacts may contain one long line; use byte ranges.

Inline command data lives under `payload.data`. Show data contains spec
identity and the selected view fields. Status, lint, get, and section get keep
named `status`, `lint`, `element`, and `section` data there. Get exposes
`elementId`, `kind`, and `elementVersion` beside its element snapshot. Status and diff default to bounded collections; use
returned omission commands or `--full` for complete data.

`baseRevision` names the current revision's immediate parent;
`currentRevision` is the latest revision regardless of state;
`currentApprovedRevision` is the latest approved one. Inspect the offline
field map and revision semantics with `cctl spec schema read-envelopes`.

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
Design; do not author both stages in one revision or batch. After Requirements
approval, `cctl spec amend <slug>` opens the Design draft. An amendment of an
approved Design also opens at Design, preserving unchanged Requirements and
their approvals. If the amendment changes a requirement or criterion, run
`cctl spec return-to-requirements <slug> --reason <why>` from the Design draft; this
withdraws the Design draft and reopens at Requirements from the revision it
amended, keeping the approved Design but none of the withdrawn draft's design
edits. Approve the changed Requirements, then use `amend` again to open Design.
`advance` concludes an open Requirements draft only when its policy does not
require human sign-off; it does not open a draft after an approval.
Inspect stage and return-path contracts with `cctl spec status --help`,
`cctl spec return-to-requirements --help`, and `cctl spec schema guidance`.

## Removal and reintroduction symmetry

Remove draft elements by handle with `cctl spec remove`. When a surviving element refers to the target, update or remove both sides in one `cctl spec draft` batch so the transaction never leaves a dangling reference.

Treat removal as reversible history, not deletion. Reintroduce the same element id with `"reintroduceHistorical": true` and `"baseElementVersion": null`; this restores its original number and handle. Use the removed element identity in the receipt to address its history.

Inspect both acts with `cctl spec remove --help`, `cctl spec draft --help`, and `cctl spec schema element-batch`.

## Correcting obsolete questions and assumptions

A question or assumption the spec has outgrown gets corrected, not left to rot. `cctl spec attention edit` rewrites an open question or a proposed assumption at the record version you last read. `cctl spec attention withdraw` retires an obsolete open record with a durable `--reason-file`. `cctl spec attention supersede` gives a disposed assumption one successor in the current amendment, preserving lineage instead of rewriting the decision a human made. `cctl spec attention cite` and `cctl spec attention uncite` change exactly which assumptions a draft element cites, at the citation version you read.

The division of labour is fixed: you correct the record, and the human answers a question and disposes an assumption. Answered, disposed, withdrawn, and superseded records are immutable history. Never answer or dispose on the user's behalf, and never open a question to hold work you should be authoring — record what you proceeded on with `cctl spec assume` and keep going.

Inspect the compare-and-swap tokens each verb takes with `cctl spec attention --help`.

## Continuous review of the draft

The human reviews the open draft while it stays editable. They can approve subjects, comment, and resolve threads at any time; only their sign-off freezes the revision. `cctl spec propose` is the request for that review: it files the Needs You entry and leaves the draft editable under a Gate dial, so keep repairing while review is in progress. When every consulted gate is Notify or Off, no human act follows, so propose freezes the draft itself.

An approval records the content the human read. Editing an approved subject — a requirement, one of its criteria, a decision, or a citation it carries — makes it unapproved again; unrelated edits leave it approved. `cctl spec status` and the propose receipt report both sides of that ledger — satisfied, split into carried, current-revision, import-settled, and combined-act, beside pending — together with its carry rule. Price a repair round off that ledger rather than re-litigating settled content, and avoid churning approved subjects you did not mean to change.

Answer review threads in the draft (`cctl spec reply`), then propose again so the reviewer knows the repair landed. A blocking thread holds sign-off until the reviewer resolves it.

## Element-id/handle/version semantics

Treat an element id as its globally unique, immutable identity — unique across every spec in the project, including abandoned ones, which keep their ids forever. Always prefix element ids with the spec slug (for example `my-spec-req-audit`) so no other spec can own yours first; a collision refuses with `element_id_taken` and the only recovery is a different id. Treat its handle, such as `R3.2` or `D4`, as the human address assigned within the spec and preserved when the same id is reintroduced. Use ids in typed references and handles in CLI addresses unless a schema says otherwise.

Treat `elementVersion` as a compare-and-swap token local to one revision. Versions restart when approved content is copied into a new amendment revision, so re-read every element before writing and never compare revisions by element version.

Because you mint element ids, one batch can create an element and cite it from a sibling's typed reference fields in the same write. Reference integrity is judged against the result of the whole batch rather than each item as it lands, so array order does not matter and a cross-reference never has to wait for a second call. Parentage is the exception to writability: `parentElementId` is fixed at creation, and an update naming a different parent is refused with `parent_immutable` — place content elsewhere by writing a new element under the parent you want and removing the old one.

Inspect the write contract with `cctl spec draft --help` and the relevant `cctl spec schema <document>` leaf.

## Importing a spec authored outside CC

Bring a spec authored outside CC in whole with `cctl spec import --file <bundle.json>`. The imported spec is born approved at design on import provenance: it records that an agent imported the content and from which source, and no approval of any kind is written, so every human gate on it stays as strong as on a spec authored here.

Run the act in one order. Check `cctl spec list` and `cctl spec search --all <query>` and stop if an existing spec already covers the work. Author the bundle from the source documents yourself: you are the parser, and the server never reads a source file. Iterate with `cctl spec import-preview --file <bundle.json>` until it reports no blocking finding and prints the handles it would allocate, so bundle-local refs resolve against the real numbering. Then import once and read the receipt. Treat a refusal as unfinished work. Inspect its `effect` and recovery facts before retrying; follow the named remedy.

Import creates new specs only; change an existing spec with `cctl spec amend` instead. Import is never an approval shortcut for work authored here — content drafted in conversation earns its approval through `cctl spec propose` and human sign-off.

The delivered field is retired and refused. Import a question already answered when the source holds the answer, and import an assumption with its real disposition — confirmed included — when the source shows it held. Carrying a source's disposition across is provenance capture, not the human disposition act: disposing an assumption here stays a Spec Studio act. Preserve unresolved questions and assumptions as unresolved, and report any review items the import receipt lists.

Inspect the act with `cctl spec import --help` and its document with `cctl spec schema import-bundle`.

## Consistency sweep and `propose --notes` protocol

Before proposing, run `cctl spec lint`, repair its consistency findings, and sweep reference integrity, criterion coverage, stale handles, and vocabulary the revision claims to supersede. Re-run the mechanical sweep until it is clean.

Lint reads handle tokens in element prose as real references, so a renumbered or removed element cannot ship a wrong `R3.2` through a clean pass. To name a handle token literally without asserting a reference, mask it as code: an inline backtick span or a fenced block, both of which lint skips, as it does link destinations and autolinks. Four-space indented code is not masked, so use a fence there.

For every review repair round, write a bounded notes file that maps prior findings to dispositions, names changed elements, and states deliberate non-changes. Attach it with `cctl spec propose <slug> --notes-file <notes.md>` so the reviewer starts from the disposition and diff rather than reconstructing intent.

A successful propose files the gate-scoped approval request itself, so the human already has the entry. The receipt reports one outcome per consulted gate — filed, already filed, not needed, filed with notice delivery uncertain, or not filed — with the attention id the human's row carries. Do not re-file what it filed: `cctl spec request-approval` is the recovery for the last two outcomes only, so repair only the gates reporting those outcomes. Read `cctl spec request-approval --help` for the gate flags.

Inspect the loop with `cctl spec lint --help`, `cctl spec diff --help`, and `cctl spec propose --help`.

## Finding classes and bounded terminal rounds

Classify each review finding as `new_risk`, `regression`, or `consistency_drift`. Repair consistency drift and run the mechanical pass before requesting another judgment round. Review any semantic repair only over its bounded changed surface.

Call a round terminal only when every consistency finding is repaired, the mechanical pass is clean, no new-risk or regression finding remains, and the repair diff contains no semantic expansion. A semantic expansion always receives another bounded changed-surface review.

Inspect the current lint and diff surfaces with `cctl spec lint --help` and `cctl spec diff --help`.

## Designed friction versus a defect

Parts of this surface resist you on purpose. Staged authoring, human-only acts, approvals that lapse when their content changes, frozen approved revisions, stable handles, immutable parents, and strict validation-strategy rules are the product working: each protects a human judgment or an audit property that would be worth nothing if an agent could route around it. Absorb that friction, follow the refusal's named next act, and read the `why:` line a designed-constraint refusal prints — it states the rule rather than apologising for it.

The rest is not the product. A read path that answers the wrong question, a message that names no recovery, a verb that does not exist, or a refusal you cannot act on is a defect: report it to the user plainly instead of inventing a workaround around it.

The heuristic: friction protecting a human judgment or an audit property is designed, so absorb it; friction in a read path, a message, or a missing verb is incidental, so report it.

## Notify only from success receipts

Notify the user that an act completed only after its success receipt proves the durable transition occurred. Treat a refusal, redirect, partial-progress receipt, or transport ambiguity as unfinished work: follow the named remedy, then notify only from the eventual success receipt.

Use `cctl <command> --help` when a receipt redirects the flow, and use `cctl spec status --help` to re-read durable state.
