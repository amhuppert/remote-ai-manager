# Native SDD UI, comments, and attention-record improvements (command-center#87)

Status: IMPLEMENTED AND VALIDATED — comment slice implemented in `f5383ec4`;
attention/citation and agent operability slices implemented and validated.
`docs/designs/ticket87-agent-operability-slice-technical-design.md` is
authoritative for the agent operability slice where more specific.
Date: 2026-08-22
Scope: Spec Studio comments, question/assumption correction, and targeted
`cctl spec` operability defects reported after real Native SDD use

## 1. Recommended outcome

Implement the ticket in three cohesive slices:

1. Make Native SDD comments correct and conversational: resolve anchors against
   the rendered block they came from, expose only the action the surface can
   perform, and render persisted comment rows as attributed threads.
2. Give an authoring agent an audit-safe way to edit or withdraw still-unresolved
   questions and assumptions. Keep human answers/dispositions and
   every frozen revision's review history immutable.
3. Remove the remaining agent-interface traps that caused the reported run to
   waste work: current-only element reads, prose-handle linting, targeted section
   reads, explicit immutable-parent refusals, automatic approval requests after
   proposal, and a two-sided approval-carry ledger.

The disposed-assumption trap requires one deeper correction in slice 2:
assumption citations must belong to a revision. A global `element_id` cannot be
both a display attachment and the citation truth for every historical revision.
Disposed assumptions remain immutable; a correction appends a successor and
changes citations only in an amendment draft.

This design deliberately does **not** add section handles, renumber handles by
display position, support reparenting a stable element, relax staged authoring,
or generalize arbitrary provenance sources. Those changes conflict with settled
Native SDD invariants or need a separate product design.

## 2. Inputs and report disposition

The ticket's agent reflection and operator note describe the same underlying
problem from two angles: stored Native SDD state is richer and safer than the UI
and agent surface make visible or operable.

The attachment titled "Issue Fix Design" is a compaction artifact from
command-center#86 about graph-workflow validation rounds. It has no Native SDD
content and is excluded from this design.

| Reported issue | Finding | Disposition |
| --- | --- | --- |
| A new inline comment immediately says `Stale anchor` | Confirmed bug: selection offsets are relative to one rendered Markdown block, but Spec Overview reanchors them against the whole section string | Fix |
| Spec comments show `Add & send`, but do not send | Confirmed bug: both actions invoke the same native comment write; the `send` flag is only logged | Fix |
| Agent replies look like unrelated comments | Confirmed presentation bug: persistence already stores `thread_id` and `parent_comment_id`, but both Overview and Review flatten or discard them | Fix |
| Replies have no agent/conversation attribution | Confirmed presentation bug: agent provenance already includes `conversationId` and optional backend, but the UI drops it | Fix |
| Agents cannot correct an obsolete open question or proposed assumption | Confirmed domain/API gap | Fix with agent edit/withdraw, compare-and-swap, and durable before/after audit events |
| A rejected/disposed assumption cannot be cleared or retargeted after amendment | Confirmed model defect: `element_id` implicitly rewrites citations across revisions, so the current guard is effectively permanent | Fix with revision-scoped citations and append-only supersession |
| Unqualified `spec get` may silently return a removed element from an older revision | Partially improved by a revision header, but still unsafe | Make ordinary reads current-only; require an explicit historical selector |
| `spec show` silently truncates | Already fixed: responses expose total/returned/truncated and exact zoom-in instructions | Close with existing regression coverage |
| Prose references to handles evade dangling-handle lint | Confirmed | Extend current-snapshot lint to Markdown prose fields |
| Section prose cannot be read narrowly | Confirmed, but sections intentionally have no handle | Add an explicit section-by-element-id read; do not invent `S` handles |
| Parent changes are silently ignored | Confirmed | Return a typed refusal explaining stable parent identity; do not implement reparenting |
| `propose` always requires a second `request-approval` call | Confirmed | Auto-file idempotent approval requests after successful proposal |
| Handle numbers follow creation rather than display order | Intentional stable-address behavior | Keep and document; teach batch-local element IDs for structured cross-references |
| Native authoring has no prospective-handle dry run | A non-reserving preview would be race-prone | Do not promise prospective handles; return allocated handles after the atomic write |
| Arbitrary source provenance is missing | Existing conversation/ticket snapshots are sound, but path/URL sources need portability, snapshot, redaction, and lifecycle decisions | Defer to dedicated provenance work |
| Stage refusals and approval carry hide important rationale | Confirmed | Add the designed-friction rationale and show both carried and pending approvals |
| Design decisions should be permitted during requirements | The reflection withdrew this recommendation; it conflicts with approved staged authoring | Keep the boundary |

## 3. Constraints that remain product behavior

The proposal distinguishes designed friction from incidental friction.

Designed constraints remain:

- requirements settle before design, and design settles before the delivery
  plan;
- humans alone approve, answer questions, dispose assumptions, resolve review
  threads, and sign off revisions;
- proposed, approved, and withdrawn revisions and their citations are frozen;
- handles are stable addresses allocated from permanent per-kind counters, not
  mutable display positions;
- an element's parent is part of its stable identity;
- Spec Studio is a review and browsing surface; authoring-agent corrections
  happen through `cctl spec` with agent provenance recorded in the audit event.

Incidental friction to remove:

- a healthy new anchor displayed as stale;
- controls that advertise an unsupported send action;
- thread, author, and conversation data hidden by UI adapters;
- silent fallback to historical content;
- a successful proposal requiring a deterministic follow-up call;
- a refusal that states only the rule and not why the rule exists;
- reporting pending approvals without the approvals that carried forward.

Every retained refusal should state the mechanism and the legitimate next act at
the point of refusal. Successful paths stay concise.

## 4. Comment design

### 4.1 Correct anchor resolution

The stored selection anchor is block-local. `deriveSelectionAnchor` records
`charStart` and `charEnd` within one source-mapped rendered block. The current
Spec Overview adapter passes the whole Markdown section into
`tryReanchorExact`, so a selection in any later paragraph usually misses at the
same offsets and becomes stale immediately.

Resolve Native SDD inline anchors where the rendered block exists:

1. Assemble native threads first. Keep each `SpecCommentView` as authoritative
   message data, but resolve only the root row's anchor; replies copy that anchor
   for persistence and must not create duplicate highlights or gutter counts.
2. Parse the root anchor, locate its stamped block with `findCommentBlock`, read
   `blockAnnotatableText`, and perform exact reanchoring against that text.
3. Re-run after deferred Markdown mounts and after rendered subtree changes,
   using the proven `MutationObserver` pattern from `use-document-comments`.
4. Adapt one root per thread to a small domain-neutral annotation DTO carrying
   annotation/thread id, anchor, resolved offsets, tone, and accessible label.
   `AnnotatedMarkdown` consumes that DTO rather than requiring native comments
   to masquerade as `DocumentComment` rows with `pending|sent` delivery state.
5. Derive highlight/gutter input and thread anchor status from that same root
   resolution. Do not independently re-resolve the thread list.
6. Distinguish:
   - `anchored`: same quote at the stored offsets;
   - `reanchored`: the unique nearby quote moved within the same block;
   - `stale`: the block exists but the quote is absent or ambiguous;
   - `orphaned`: the referenced element no longer exists in the viewed revision.

The native wrapper derives `reanchored` by comparing `tryReanchorExact`'s
returned offsets with the stored offsets; the shared exact-match function does
not need a breaking result-type change.

Overview uses rendered-block resolution. Review's element-level synthetic
anchors keep their existing element-body resolver. The shared thread component
accepts the host's resolved state rather than inventing a third anchoring rule.

### 4.2 Expose capabilities, not a discarded `send` boolean

Replace the annotation composer's implicit two-action contract with a
discriminated capability:

```ts
type CommentComposerCapability =
  | {
      kind: "persist-only";
      submit(input: PersistCommentInput): Promise<void>;
    }
  | {
      kind: "persist-or-send";
      submit(
        input: PersistCommentInput & { delivery: "queue" | "send" },
      ): Promise<void>;
    };
```

The exact type names are illustrative; the behavioral contract is not:

- Native SDD receives `persist-only` and renders one primary action,
  **Add comment**.
- The Docs feedback surface receives `persist-or-send` and retains **Add
  comment** plus **Add & send**.
- `send: true` is not representable in the Native SDD call path.

Submission disables the actions but retains the draft until the promise
resolves. The popover closes and clears selection only after persistence
succeeds. A refusal or network failure leaves the note editable and announces an
inline error, so a proposal-state race cannot discard operator text.

Root comment composition is enabled only for a human viewing the current
proposed revision. Historical, draft, approved, withdrawn, and abandoned views
remain readable but do not advertise a server-refused action.

### 4.3 One native thread component

Add a native `SpecCommentThread` presentation component and reuse it in Overview
and Review. It receives native comment rows plus a resolved anchor state.

Thread assembly rules:

- group by `threadId`;
- select the root by `parentCommentId === null` rather than array position;
- order roots and replies by `(createdAt, id)` for deterministic ties;
- render the root once and replies beneath it;
- expose explicit `openThreadCount` and `openBlockingThreadCount` fields from
  the comments/status projections instead of silently changing the legacy
  row-oriented `openCount` contract;
- keep resolved, stale, orphaned, and historical threads visible as review
  history.

The quote belongs to the thread root and is shown once. Every message row shows:

- `Operator` for current human provenance;
- `<Backend> agent` when an agent backend is known, otherwise `Agent`;
- timestamp;
- **Open conversation** for an agent row with a `conversationId`, generated by
  `conversationsPageHref`;
- `Unknown author` for legacy rows without valid provenance;
- original revision and element handle (or element id when no handle exists) on
  the thread root.

The UI adds **Reply** for any still-open thread. It shows **Resolve** only when
the root's `revisionId` equals the viewed revision, that revision is `proposed`,
the thread remains open, and the transport is human; the mutation sends the
root's revision id. These use the existing `reply` and `resolve-thread` actions.
Resolving applies to the thread, not one row.

A gutter pin represents every root thread on its rendered block, counts threads
rather than replies, and targets a labelled thread-group region rather than an
arbitrary first thread. Its accessible label is, for example, “2 review threads
on this passage.” Activation focuses the `tabIndex={-1}` group or sole thread.
Because CSS Custom Highlights are not focusable DOM, the quote control returns
focus to the gutter button or a programmatically focusable source block—not to
the painted highlight.

Current threads remain co-located under their narrative section or review change
card. Removed-element and otherwise unplaceable roots appear in a dedicated
**Historical & orphaned review threads** region after current content. That
region always shows original revision, element handle/id, anchor state, and the
persisted lifecycle label (`Resolved` or `Dismissed`) so historical feedback
cannot look current.

### 4.4 Visual treatment

Threads stay immediately below their narrative section or review change card.
A third page sidebar would compete with the existing structure rail and make
mobile review worse.

Desktop sketch:

```text
┌─ REVIEW THREAD ─────────────────────────────────────── OPEN ─┐
│ “the exact selected passage”                                │
│                                                             │
│ OPERATOR · Aug 22, 10:14                                    │
│ This needs to state the failure behavior.                   │
│                                                             │
│   ┃ CLAUDE AGENT · Aug 22, 10:18   Open conversation ↗      │
│   ┃ Added the timeout and recovery requirement in R4.2.     │
│                                                             │
│ [Reply]                                           [Resolve] │
└─────────────────────────────────────────────────────────────┘
```

Mobile sketch:

```text
┌─ REVIEW THREAD ───── OPEN ─┐
│ “selected passage…”        │
│ OPERATOR · Aug 22           │
│ Root comment               │
│ ┃ CLAUDE AGENT · Aug 22    │
│ ┃ Reply…                   │
│ ┃ Open conversation ↗      │
│ [Reply] [Resolve]          │
└────────────────────────────┘
```

Use existing tokens and primitives: `bg-bg-surface`, `border-border-dim`,
`border-border-subtle`, `text-text-secondary`, `Button`, `StatusChip`,
`MultilineInput`, and `CompactMarkdown`. The reply rail uses a subtle left
border and spacing, not a second nested card. Healthy anchors do not need an
`Anchored` chip; show chips only for `Reanchored`, `Stale anchor`, `Orphaned`,
blocking, and resolved states.

Each thread is a labelled `<article>` containing an ordered message list. Each
message uses a `<li>`, an explicit root/reply label, and `<time dateTime>`. The
inline Reply form moves focus into its labelled input, announces pending success
with `role="status"` and failure with `role="alert"`, and restores focus to Reply
or the next stable action after cancel, success, or resolve.

Gutter targets are at least 24×24px on desktop and 44×44px on narrow screens;
ordinary actions remain 44px at every size. Thread targets use scroll margin (or
their scroll container uses bottom padding) matching Review's sticky footer so
programmatic focus is never obscured. Metadata wraps, and the conversation link
stays keyboard reachable with a descriptive accessible name.

Storybook states required before page integration:

- fresh root comment;
- root plus agent reply and conversation link;
- multiple replies with deterministic order;
- blocking open and resolved;
- reanchored, stale, and orphaned;
- co-located roots reached from one grouped gutter pin;
- historical/orphaned fallback region with original revision;
- unknown legacy author;
- 390px mobile layout and 200% zoom.

## 5. Questions and assumptions

### 5.1 Edit and withdraw only unresolved records

Questions and assumptions keep their stable `Qn`/`An` handle while unresolved.
Add common current-row metadata and one authoritative lifecycle transition:

- `record_version INTEGER NOT NULL DEFAULT 1`;
- `withdrawn_at TEXT NULL`;
- `withdrawn` as a terminal question status and assumption disposition;
- a reason in the mutation event; actor and occurrence time remain event
  metadata.

The legal states are explicit:

| Record | Active | Human terminal act | Author terminal act |
| --- | --- | --- | --- |
| Question | `open` | `answered` | `withdrawn` |
| Assumption | `proposed` | `confirmed`, `rejected`, or `deferred` | `withdrawn` |

`withdrawn_at` is required exactly when the authoritative enum is `withdrawn`.
Answer fields are present exactly for `answered`; disposition timestamps are
present exactly for the three human assumption outcomes. `withdrawn` does not
pretend to be a human judgment about whether the premise is true: only an agent
withdrawal action can write it, while the human disposition action
continues to accept only confirmed/rejected/deferred.

An edit or withdrawal is admitted only when all of these are true:

- a question is `open` and unanswered, or an assumption is `proposed` and
  undisposed;
- it is not already withdrawn;
- the spec is not abandoned;
- the caller is an authenticated authoring agent;
- the caller supplies the current `recordVersion`;
- for an assumption cited by frozen history, an amendment draft exists to carry
  the corrected current citation snapshot. If the current citing revision is
  still proposed, the refusal directs the author to end that review attempt and
  open the draft first.

Use a guarded update (`WHERE record_version = ?` plus lifecycle predicates) and
increment the version in the same transaction. A stale writer, a human
transport, or a terminal record receives a typed refusal
with the exact recovery. Human answer/disposition mutations use the same version
guard so only one terminal transition wins. `updated_at` is not a sufficient
compare-and-swap token.

An assumption edit updates only the current draft's citation snapshots; an
assumption withdrawal removes only current-draft citations. Both use the draft's
citation-set compare-and-swap token. Proposed, approved, and withdrawn citation
snapshots stay byte-for-byte unchanged. Every Q/A read view, including `spec
get` and the bounded status projection, returns `recordVersion` so the admitted
mutation is actually callable.

Apply one server-owned abandoned-spec guard to open, answer, propose, dispose,
edit, withdraw, supersede, cite, and uncite. Do not rely on the Studio's read-only
presentation as a state invariant.

Do not add human edit/withdraw controls to Spec Studio in this ticket. This
change provides a correction path for authoring agents through `cctl spec`;
humans retain answer/dispose authority. Studio displays edits, withdrawals,
provenance, and history.

### 5.2 Durable audit events and active projections

Reuse the repository-append-only `spec_events` table and its existing actor/time
columns. This matches current audit enforcement; this ticket does not claim a
new database trigger prevents direct `UPDATE`/`DELETE` of event rows.

Add two strict, versioned event payloads. `spec-review-record-mutated` records
creation/import as well as edit, answer, disposition, withdrawal, and
supersession:

```ts
{
  schemaVersion: 1,
  recordKind: "question" | "assumption",
  recordId: string,
  recordNumber: number,
  operation:
    | "opened"
    | "proposed"
    | "imported"
    | "edited"
    | "answered"
    | "disposed"
    | "withdrawn"
    | "superseded",
  reason?: string,
  attentionId: string, // stable record id
  active: boolean,
  successorAssumptionId?: string,
  before: RecordAuditSnapshot | null,
  after: RecordAuditSnapshot
}
```

`reason` is required for withdrawal and supersession and omitted only where the
new answer/disposition/body is itself the complete act.

`RecordAuditSnapshot` is the strict question/assumption union defined in the
slice technical design. It includes record version, authored content,
attachment, lifecycle/answer/disposition timestamps, and supersession
relations.

`before` is null only for opened, proposed, or imported records. New creation
and import paths append this typed event. The migration does not invent events
or terminal actors for pre-cutover rows; History labels its mutation coverage as
starting at cutover when no truthful typed event exists.

`spec-assumption-citations-mutated` records the revision id, citation-set version
and hash before/after, and ordered added, removed, and refreshed triples.
Supersession writes predecessor-superseded, successor-proposed, and citation
events in the same transaction as successor creation and citation replacement.
Edits publish `spec-attention-changed` with `active: true`; withdrawals publish
it with `active: false`, while supersession records predecessor-inactive and
successor-active attention identities.

Keep repository reads complete. Derive two explicit projections instead of
globally filtering rows:

- active status, lint, and Needs You use only open/proposed, non-superseded
  records;
- detail, handle lookup, History, and export retain every record and expose a
  derived active/withdrawn/superseded/answered/disposed presentation.

Answer and disposition services refuse withdrawn or superseded records, and a
second human disposition is refused rather than overwriting the first.

Expose the two typed mutation event families in the canonical Q/A audit export,
ordered by event id, rather than exporting unrelated spec events. Bump the export
format for the new typed history. The History panel reads this durable projection
instead of synthesizing edit history from the current row.

### 5.3 Revision-scoped assumption citations

Add a relation whose authoritative key is:

```text
(revision_id, element_id, assumption_id)
```

Each row also carries a strictly parsed `assumption_snapshot_json`: record
version, text, disposition, attachment, provenance, and lifecycle timestamps as
observed by that revision. The snapshot, not the mutable current assumption row,
is what historical lint, review, export, and display read. This is what makes an
amendment-safe later edit or disposition possible: frozen revisions keep the
premise they reviewed while the amendment draft advances its snapshot.

`assumption.element_id` becomes display/attention attachment only. Lint and
sign-off read revision citation rows, never infer citations from the mutable
current assumption row.

Citation rows are part of the revision review contract:

- every revision snapshot/view includes citations in stable sorted order;
- the revision stores `citation_version` for draft compare-and-swap and a
  `citation_hash` over each sorted triple plus its assumption snapshot;
- the existing element `content_hash` remains unchanged for historical
  compatibility; integrity verification validates the additional citation hash;
- semantic diff emits citation add/remove/replace/update entries, so a
  citation-only or cited-assumption-state amendment is never an empty change;
- an element approval fingerprint includes that element's citation set, and
  revision sign-off includes the full citation hash, so citation changes stale
  the approvals whose reviewed premise changed;
- canonical export/verify carries and validates citation rows and their hash.

`citation_version` and citations are editable only while the revision is a
draft. Proposed, approved, and withdrawn revisions freeze both rows and hash.

Do not retroactively claim legacy humans approved reconstructed citation state.
Each revision carries `citation_contract_version`:

- existing proposed, approved, and withdrawn revisions migrate as version 1
  (`legacy_element_only` approval basis). Their existing approval and sign-off
  remain valid for that exact historical revision; export/verify names the
  basis and treats the backfilled citation hash as cutover integrity, not as
  evidence the human reviewed it;
- existing drafts migrate as version 2. They have no frozen review basis, so a
  post-cutover approval must fingerprint their backfilled citations;
- every revision created after cutover is version 2, including born-approved
  imports. Its approvals or import-settlement basis fingerprint citation
  snapshots as described above;
- a version-1 element approval may carry into the first version-2 amendment only
  when the element payload is unchanged **and** both base and amendment have no
  assumption citations for that subject. If either side has a citation, the
  approval becomes pending with the reason `legacy approval did not fingerprint
  assumption citations`;
- revision sign-off remains per-revision and never carries. Import settlements
  retain their distinct non-approval basis.

This grandfathering preserves already-approved specs without falsifying their
review basis, and forces the first citation-aware review to price every affected
premise.

Migration backfill must reproduce current behavior exactly: for each revision
snapshot containing the attached element, create the citation when the current
projection would have created it, including its proposed-time cutoff, then store
the assumption state visible at cutover as a typed `legacy_backfill` snapshot and
store its citation hash without rewriting the legacy content hash. Historical
state that the old global-row model never retained cannot be recreated; the
cutover preserves the system's pre-cutover answer and makes subsequent history
stable.

Every revision-creation path owns citation behavior:

- opening an amendment, withdrawing a proposal into a draft, and any other
  draft fork copy the base snapshot's citations atomically;
- an attached assumption created in a draft adds that draft citation;
- born-approved import creates an unobservable draft inside its transaction,
  materializes citations, then hashes and finalizes it to approved before
  commit;
- editing or first disposing an assumption under an amendment updates the draft
  citation snapshot and increments both record and citation versions while
  leaving every frozen snapshot unchanged;
- removing an element from a draft removes its citations in the same operation
  and receipt; reintroduction does not silently restore them;
- cite/uncite/supersede validate that the element exists in the named draft, not
  merely in the stable element registry.

This ticket intentionally strengthens the product contract: once a human
disposes an assumption, its text, attachment, and disposition are immutable even
when uncited. Corrections are append-only. Add
`supersedes_assumption_id` to the successor row with same-spec validation, an
immutable-after-insert rule, a composite same-spec foreign key, `id !=
supersedes_assumption_id`, and a unique non-null predecessor index. A successor
is always newly created and may point only to a pre-existing assumption;
therefore the immutable edge cannot form a cycle and concurrent forks cannot
commit. The transaction increments the predecessor's
`record_version` without changing its text, attachment, or human disposition;
the reverse successor relation is the single source for its superseded display.

The first human disposition remains legal for a proposed assumption. When a
frozen revision cites it, the service requires an amendment draft, updates only
that draft's citation snapshot, and leaves the older observed `proposed` state in
place. A later change from one human disposition to another is never an in-place
update; it uses the successor flow below.

The correction flow is:

1. open or reuse an amendment draft;
2. create a successor assumption with `supersedes_assumption_id`;
3. replace, retarget, or clear citations in that draft atomically;
4. leave every non-draft revision's citation rows and old assumption unchanged.

Supersede checks the predecessor `recordVersion` and the draft
`citationVersion`; its strict payload carries an operation id and the successor
stores that id plus a canonical request hash. Cite/uncite checks the draft
`citationVersion`. The operation id and unique predecessor relation make an
ambiguous retry return the already-created successor rather than allocate
another handle, while reuse with different input refuses. If that successor is
still proposed, a different correction edits or withdraws it; after human
disposition, a later correction supersedes it.

The current revision can therefore stop citing rejected `A4` without making an
old approved revision appear never to have cited it. The UI shows **Supersedes
A4** on the successor and **Superseded by A8** on the old record. Superseded and
withdrawn records move to a collapsed **Record history** group; they are not
deleted.

### 5.4 Agent surface

Introduce a progressively disclosed `spec attention` subfamily rather than
overloading creation verbs:

```text
cctl spec attention edit <slug> <Qn|An> --file <update.json> --if-version <n> [--if-citation-version <n>]
cctl spec attention withdraw <slug> <Qn|An> --reason-file <reason.md> --if-version <n> [--if-citation-version <n>]
cctl spec attention supersede <slug> <An> --file <successor.json> --if-version <n> --if-citation-version <n>
cctl spec attention cite <slug> <An> --element <handle> --revision <draft-id> --if-citation-version <n>
cctl spec attention uncite <slug> <An> --element <handle> --revision <draft-id> --if-citation-version <n>
```

`supersede` accepts citation replacements in its file payload so creation and
draft citation changes are atomic. `cite`/`uncite` refuse non-draft revisions.
An assumption edit/withdraw requires the optional citation version whenever the
current draft cites it; local preflight names the missing token before network.
At initial `assume --element`, the element is both display attachment and the
new draft citation. Later attachment and citation changes are explicit separate
fields: an assumption edit that moves its attachment without accompanying
citation operations is refused rather than silently retargeting review truth.
`spec get Qn|An` exposes `recordVersion`; the draft edit-context and attention
reads expose `citationVersion` and the exact citation triples.
The Native SDD authoring guidance names these commands when a record becomes
obsolete; it must not tell an agent to reject an assumption, because disposition
is a human judgment.

## 6. Targeted `cctl spec` improvements

### 6.1 Current-only reads

An unqualified `cctl spec get <slug>/<handle>` reads only the current revision.
If the handle exists only historically, return a `historical_only` refusal that
names the last revision and the explicit historical read. Add an explicit
revision selector for intentional archaeology; preserve `observedRevision` for
reference-chip resolution.

The important invariant is that ordinary reads can never silently answer a
current authoring question with withdrawn content.

### 6.2 Prose reference lint

Extend `9.6.dangling-handle` to Markdown-bearing prose fields in the current
snapshot, including section bodies, requirement statements, criterion text and
validation notes, and decision/task prose.

Use a Markdown-aware text extractor and the canonical handle parser. Recognize
bare and slug-qualified `R`, criterion, `D`, `T`, `Q`, and `A` tokens at lexical
boundaries; ignore URL fragments, larger alphanumeric words, and fenced code.
Valid current handles pass, while removed and unknown handles retain the current
`blocks_propose` finding. Tests define the false-positive boundary rather than
adding an unreviewed regex inside lint.

### 6.3 Narrow section read without section handles

Add:

```text
cctl spec section get <slug> --id <element-id>
```

It returns one current-revision section with `handle: null`, its stable element
id, role, title, body, and version. Historical section reads require the same
explicit revision selector as element reads. This solves narrow retrieval while
preserving the approved single handle grammar.

### 6.4 Make immutable parentage explicit

When an ordinary update supplies a different `parentElementId`, refuse it rather
than silently preserving the old value. The refusal says that parentage belongs
to stable identity across revisions and directs the author to create a
replacement under the desired parent and remove the old element from the draft.

Actual reparenting would retroactively change containment in every revision
because parentage lives in the stable element registry; it is not part of this
ticket.

### 6.5 Proposal and approval carry

Put the behavior in a server-side propose coordinator used by every client, not
in CLI glue. The coordinator:

1. freezes the revision through the existing authoring service;
2. identifies that revision's concluding authoring gate;
3. calls the existing approval-request service with no subject — normally once
   for the concluding gate, and once per pending gate when a cumulative
   proposal leaves earlier consulted stages with pending subjects — producing
   the gate-scoped ask whose payload already lists every outstanding subject and
   sign-off obligation;
4. reuses the request service's stable identity when that ask already exists;
5. catches a notifier exception after the durable request commit and returns a
   typed delivery outcome rather than converting proposal success into failure.

The receipt reports `filed`, `already-filed`, `not-needed`,
`delivery-uncertain`, or — when the durable filing itself failed and no
request exists — `not-filed`, per gate, with the stable attention id when one
exists. Keep
`request-approval` as the explicit retry/repair verb; its idempotent notifier
ensure can recover a delivery-uncertain request. Neither notification failure nor
retry rolls back or duplicates the proposed revision.

Status, proposal, reopen, and withdrawal receipts show both sides of the
approval ledger, for example:

```text
approval subjects: 12 satisfied (8 carried, 3 current-revision, 1 import-settled) · 6 pending
carry rule: unchanged subject content under the same applicable gate
```

`carried` means a still-applicable human approval from an ancestor;
current-revision human approvals and import-settled subjects remain distinct,
because an import settlement is not an approval. A collapsed fast-path gate
still reports the per-item approvals and sign-off that its combined act records,
for example `approval subjects: 18 satisfied (18 combined-act) · 0 pending` and
`sign-off: satisfied (combined act)`. It never labels those subjects not
applicable or manufactures a zero-count ledger.

The flagship `stage_blocked` refusal gains one stable rationale line:

```text
why: requirements settle before design so solution choices cannot shape the
contract around themselves
```

Native SDD does not provide, document, or recommend a place to park premature
design work. It assumes spec work begins with requirements, and its authoring
guidance directs agents to complete requirements without producing design until
the design stage opens. Q/A records remain reserved for genuine requirement-stage
unknowns and premises; they are governed human-attention records, not design
notes. The skill also labels the stable-handle, immutable-parent,
human-authority, and staged-authoring rules as designed constraints, so agents
do not mistake them for missing features.

## 7. Page coherence and responsive behavior

- Keep the existing primary tabs and two-column Overview. Comment threads live
  under the content they discuss; the structure rail remains structural. The
  historical/orphaned region follows current narrative content.
- Questions & assumptions keeps active Questions and Assumptions first. Add a
  collapsed Record history region for withdrawn and superseded records.
- Show agent provenance on Q/A cards with the same conversation link treatment
  as comment replies.
- Hide disposition buttons after an assumption leaves `proposed`; the server
  also refuses a second disposition instead of overwriting it.
- At 768px and below, all cards are one column, reply rails indent by one spacing
  step, metadata wraps before actions, and buttons retain 44px targets.
- No new global CSS or tokens. Prototype the reusable thread and attention
  history states in Storybook before integrating them into the page.

Questions & assumptions sketch:

```text
ASSUMPTIONS                                           1 PROPOSED
┌ A8 · PROPOSED ─────────────────────────────────────────────┐
│ CLAUDE AGENT · Open conversation ↗                         │
│ Cache invalidation may lag the durable write by 2 seconds. │
│ Supersedes A4 · Attached to R3                              │
│                         [Confirm] [Reject] [Defer]          │
└────────────────────────────────────────────────────────────┘

▸ RECORD HISTORY · 2
  A4 · REJECTED · Superseded by A8
  A2 · WITHDRAWN · “Source contract was corrected”
```

Required attention stories cover an edited open question, an agent-proposed
assumption with conversation provenance, a human-disposed assumption, a
withdrawn record, a supersession chain, empty history, and the same states at
390px and 200% zoom.

## 8. Data and compatibility impact

This is a quiesced schema cutover, not an ordinary additive migration. Old builds
do not understand the new lifecycle enum, citation authority, or strict event
types and must not write after cutover.

The cutover comprises:

1. preflight existing Q/A rows for cross-field contradictions and stop with the
   offending record ids rather than silently normalize them;
2. synchronously rebuild the question/assumption table definitions in
   `state-db.ts`, adding `record_version`, `withdrawn_at`, the `withdrawn` enum
   values, `supersedes_assumption_id`, and supersession operation-id/request-hash
   fields with their foreign-key/service guards and unique non-null indexes;
3. add `citation_contract_version`, `citation_version`, and non-null
   `citation_hash` to revisions plus the revision-scoped citation table and
   lookup indexes; existing frozen revisions receive contract version 1,
   existing drafts receive version 2, and every new revision, including a
   born-approved import, uses version 2;
4. run the ordered data migration that backfills record version 1, materializes
   every historical citation using the old projection rule, and writes each
   revision's citation hash without changing its existing content hash;
5. validate all backfilled citation foreign relations against the element set of
   the named revision and verify every content/citation hash pair;
6. install strict triggers against later non-draft citation-row and
   citation-metadata mutation;
7. register both strict durable event payloads, the extended views, semantic
   diff/fingerprint logic, and the new canonical export version;
8. bump `KNOWN_SCHEMA_VERSION` as a write/read barrier before any new event or
   lifecycle state is emitted.

SQLite cannot add the cross-field `CHECK`s with `ALTER COLUMN`; the synchronous
Q/A table rebuild and strict triggers that prevent non-draft citation/hash
mutation are part of the design, not optional cleanup. The repository migration
lock/quiescence covers the entire structural change and backfill.

Do not add a compatibility shim, dual-write path, old-build fallback, or
old-build reader. The schema-version barrier intentionally makes an old build
refuse the upgraded database rather than corrupt state it cannot understand.

Before implementation, amend the approved Native SDD requirement/design/task
documents for the new Q/A terminal state, agent mutation, disposed-record
immutability, revision-pinned assumption snapshots, citation-priced approvals,
thread attribution, and the changed `cctl spec` read contract. The current
proposal is the product/technical direction for that formal phase update; it is
not permission to skip the existing requirements → design → tasks approvals.

Comments require no storage migration: native thread and provenance fields
already exist. The UI must not migrate Native SDD comments into generic
`DocumentComment`; that model lacks revision/element identity, threads,
blocking/resolution, and author provenance.

## 9. Red-green-refactor and verification plan

Implementation follows behavior-first TDD. Each loop runs the registered test
command scoped to the one test file under change.

### Comment slice

- A selection in the second Markdown block creates a comment that resolves
  anchored after refresh.
- Native composition renders only **Add comment**; Docs retains both actions.
- Root plus agent reply renders one thread, correct hierarchy, provenance, and a
  conversation link.
- Legacy author fallback, deterministic tie ordering, resolved, stale, and
  orphaned states render correctly.
- One root plus two replies produces one annotation and reports
  `openThreadCount: 1`; the compatibility row count remains explicitly named.
- Co-located roots share a labelled gutter group and focus its matching thread
  region; orphaned roots appear in the historical fallback.
- A failed create retains the note and announces the error; success alone closes
  the composer.
- Composition/reply/resolve controls match revision and actor capabilities.
- Thread/list semantics, focus restoration, sticky-footer clearance, 390px, and
  200% zoom meet the stated accessibility contract.

### Attention/citation slice

- Edit and withdrawal succeed for any authenticated authoring agent, including
  one in a later conversation; human transport, stale version,
  answered/disposed/withdrawn, abandoned spec, and frozen-citation cases refuse
  for the right reason.
- Row update and audit append roll back together on failure.
- Withdrawn records disappear from active attention/lint counts but remain in
  handle reads, History, and canonical export.
- A citation copied into an amendment can be replaced or cleared without
  changing the approved base revision.
- Supersession creates one successor and atomically updates only draft
  citations.
- Proposed, approved, and withdrawn citation sets are frozen and tamper-evident;
  a citation-only amendment changes semantic diff and the affected approval
  fingerprint.
- Import, every draft-opening path, and element removal produce the exact
  citation set and hash the design specifies.
- Legacy approvals remain valid on their exact version-1 revision, never claim a
  citation-aware basis, and fail to carry onto a cited version-2 subject with the
  specified reason.
- Citation-set CAS and the unique predecessor relation prevent stale replacement
  and duplicate successors, including ambiguous retries.
- Cross-field constraints reject contradictory rows.
- Migration preflight, backfill verification, and the schema-version barrier
  fail closed on incompatible data/builds.

### Agent-interface slice

- A current-only read refuses a historical-only handle and names the explicit
  historical command.
- A section read returns exactly one current section and no invented handle.
- Prose lint covers valid, unknown, removed, and false-positive-boundary cases.
- An attempted parent change is refused, not ignored.
- Proposal creates approval requests once; retry is idempotent; delivery failure
  leaves the proposal successful and reports `delivery-uncertain`.
- Status and receipts distinguish carried, current-revision, import-settled, and
  pending subjects, including a collapsed fast-path gate.

After unit/integration coverage is green:

- run changed-scope validation;
- review all required Storybook states at desktop, 390px, and 200% zoom;
- verify keyboard focus between source block, gutter pin, thread group, reply,
  and resolve;
- run axe on the thread and Questions & assumptions stories;
- exercise one live round trip: comment → agent reply → conversation link →
  resolve, plus question edit/withdraw and assumption amendment supersession;
- verify durable database state and canonical export, not only rendered UI.

## 10. Acceptance criteria

The design is complete when implementation can prove all of the following:

1. A freshly created Native SDD comment on any rendered block is never stale
   unless the selected passage actually changed or became ambiguous.
2. Native SDD exposes no send action it cannot perform.
3. A comment thread is rendered once, with visually nested replies, author,
   timestamp, and a working conversation link for agent provenance.
4. Thread-oriented projections, annotations, and lifecycle actions operate on
   roots/threads, never reply rows, without silently redefining legacy row
   counts.
5. An authenticated authoring agent can safely edit or withdraw an unresolved
   Q/A record, while terminal facts and every non-draft revision remain
   immutable and auditable.
6. Withdrawn and superseded records leave active attention without disappearing
   from history or export.
7. An amendment can replace, retarget, or clear a disposed assumption citation
   without changing any proposed, approved, or withdrawn revision; citation-only
   changes are hashed, diffed, exported, and priced into approval applicability.
8. An ordinary element read never silently returns historical content.
9. Prose handle references participate in dangling-handle lint.
10. Sections are narrowly readable without adding a second handle vocabulary.
11. Parent immutability, staged authoring, and stable allocation are explained
    at the refusal/help surface instead of silently worked around.
12. Proposal and approval-carry output leaves the agent with one truthful next
    action and both sides of the approval ledger.

## 11. Implementation non-goals

- named human identity or multi-user permissions;
- arbitrary URL/path source attachment and snapshot policy;
- section handles;
- position-derived or renumbered handles;
- reparenting an existing stable element;
- a speculative native-handle reservation/dry-run protocol;
- changing the requirements → design → plan stage order;
- replacing the native review-comment domain with document feedback storage.
