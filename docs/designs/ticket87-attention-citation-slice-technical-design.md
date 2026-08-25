# Native SDD attention and citation slice technical design (command-center#87)

Status: IMPLEMENTED — Native SDD task group 25 complete and validated
Date: 2026-08-22
Scope: question and assumption correction, assumption supersession,
revision-owned assumption citations, integrity/export, the `cctl spec attention`
surface, and the Spec Studio attention register

## 1. Outcome

Native SDD gains an audit-safe correction model for questions and assumptions
without weakening staged authoring or rewriting review history:

- any authenticated authoring agent can edit or withdraw an unresolved record,
  even when a different conversation created it;
- humans remain the only actors who answer questions or dispose assumptions;
- answered questions and human-disposed assumptions remain immutable;
- a disposed assumption is corrected by appending a successor, never by
  changing the human judgment in place;
- assumption citations belong to a revision and carry a frozen snapshot of the
  premise that revision reviewed;
- citation-only changes are visible to diff, integrity verification, approval
  applicability, lint, review, and canonical export;
- Spec Studio presents current records first, history separately, and the
  conversation provenance already stored by the backend; and
- a schema-version barrier rejects old processes after a coordinated cutover.

This is one delivery slice. A smaller assumption CRUD change would continue to
let a mutable global row change the apparent premise of a frozen revision.

## 2. Governing decisions

The following decisions are settled for this slice:

1. **No creator ownership check.** The creating conversation is provenance, not
   authorization. A later authenticated authoring agent may correct an
   unresolved record.
2. **Requirements come first.** Native SDD does not provide, document, or
   recommend a place to park premature design. Questions represent genuine
   unknowns and assumptions represent premises needed to proceed with
   requirements.
3. **No compatibility path.** Do not add a shim, dual-write, old global-citation
   fallback, optional old shape, or old-build reader/writer.
4. **Human authority stays narrow.** Humans answer questions, dispose
   assumptions, approve content, resolve review threads, and sign off.
   Authoring agents may correct unresolved attention records and may author
   draft citation changes.
5. **Frozen revisions stay frozen.** Proposed, approved, and withdrawn revision
   elements, citation rows, citation snapshots, and hashes are immutable.
6. **Stable handles remain stable.** Edit, withdrawal, and supersession do not
   renumber `Qn` or `An` handles.

This document is authoritative for the attention/citation slice where it is
more specific than the parent ticket design. The parent design is updated with
every shared wire or persistence contract changed here so the two do not define
parallel truths.

The approved requirements → design → tasks gate remains in force. Before code
implementation, the approved Native SDD requirements must be amended and
approved for the behavior in this document; then its design and tasks must be
amended and approved in order.

## 3. Confirmed current defects

| Surface | Current authority | Defect |
| --- | --- | --- |
| Q/A storage | Stable spec-global rows and handles | No record version, withdrawal, successor relation, or cross-field lifecycle checks |
| Q/A service | Atomic row write plus generic attention event | Broad upserts, no CAS, incomplete actor/state guards, and a second disposition can overwrite the first |
| Citations | `assumption.element_id` plus a proposal-time cutoff | A mutable current row is treated as citation truth for every revision |
| Revision snapshot | Stage plus element versions | Citations are absent from hash, diff, verification, and export |
| Approval carry | Element ids and payload hashes | A premise can change without invalidating the approval that relied on it |
| Studio Q/A | Whole-spec rows | Terminal assumptions still show controls; provenance, history, and card-local mutation state are missing |
| Studio Review | Mutable whole-spec assumption map | A view labelled as one revision can show a later assumption state |
| History | Events synthesized from current timestamps | Edits, withdrawals, and supersession cannot be reconstructed |
| CLI | `question`, `answer`, and `assume` only | No correction, citation, version, or recovery surface |

The current global projection also creates a sign-off trap: a rejected attached
assumption remains inferred as cited, but no supported operation can clear or
retarget that citation. The attached real-world reflection required 26 element
operations to work around this model.

## 4. Scope

### 4.1 Included

- Versioned question and assumption rows with guarded state transitions.
- Agent edit and withdrawal of unresolved records.
- Append-only assumption supersession after a human disposition.
- Revision-owned assumption citation rows and strict frozen snapshots.
- Citation-set CAS, hashing, semantic diff, approval fingerprints, lint,
  import, export, and verification.
- All draft creation, fork, amendment, request-changes, element-removal, and
  born-approved import paths.
- Strict Q/A mutation audit events and citation mutation audit events.
- Complete current/history projections and active-attention counts.
- `cctl spec attention edit|withdraw|supersede|cite|uncite`.
- A redesigned Spec Studio Questions & Assumptions surface, revision-pinned
  Review rendering, and typed History entries.
- A quiesced breaking migration and schema-version barrier.

### 4.2 Excluded

- Human edit, withdrawal, cite, uncite, or supersede controls.
- Deleting records or rewriting answered/disposed records.
- Restricting corrections to the conversation that created the record.
- Design notes, scratch-design artifacts, or any encouragement to design before
  requirements are approved.
- Current-only generic element reads, prose-handle lint, targeted section reads,
  parent-change refusals, automatic approval requests, and the approval ledger;
  those remain the third ticket slice.
- Section handles, handle renumbering, reparenting, arbitrary provenance,
  named human identity, or a general permissions system.
- Compatibility shims, dual writes, fallback inference, or mixed-version
  operation.

## 5. Domain model

### 5.1 Lifecycle

The stored lifecycle enum is the one authoritative state. Timestamps are
metadata constrained to agree with it.

| Record | Mutable state | Human terminal states | Agent terminal state |
| --- | --- | --- | --- |
| Question | `open` | `answered` | `withdrawn` |
| Assumption | `proposed` | `confirmed`, `rejected`, `deferred` | `withdrawn` |

Legal transitions are:

```text
question:   open ──human answer──► answered
                 └─agent withdraw─► withdrawn

assumption: proposed ──human disposition──► confirmed | rejected | deferred
                    └─agent withdraw──────► withdrawn

disposed assumption ──agent supersede──► new proposed assumption
```

Supersession does not change the predecessor's disposition. It adds an
immutable successor edge; `superseded` is a derived presentation state, not a
second lifecycle field.

Cross-field constraints are strict:

- an `open` question has no answer, `answered_at`, or `withdrawn_at`;
- an `answered` question has a non-empty answer and `answered_at`, and no
  `withdrawn_at`;
- a `withdrawn` question has `withdrawn_at`, and no answer or `answered_at`;
- a `proposed` assumption has neither `disposed_at` nor `withdrawn_at`;
- `confirmed`, `rejected`, and `deferred` require `disposed_at` and forbid
  `withdrawn_at`; and
- a `withdrawn` assumption has `withdrawn_at` and no `disposed_at`.

`text`, display attachment, creation provenance, creation time, number,
supersession predecessor, and any human terminal result are immutable once a
record is terminal. A second answer or disposition is refused, including an
identical retry; the receipt from the first result remains readable.

### 5.2 Authorization and admission

Every mutation is guarded inside the service, not only at the route or UI:

| Act | Required actor | Additional admission |
| --- | --- | --- |
| Open question | Authenticated authoring agent | Spec is not abandoned |
| Propose assumption | Authenticated authoring agent | Spec is not abandoned |
| Edit/withdraw open question | Authenticated authoring agent | Open lifecycle and record CAS |
| Edit proposed assumption | Authenticated authoring agent | Proposed lifecycle and record CAS; citation CAS when cited in the draft; writable amendment when frozen history cites it; explicit citation intent when attachment changes |
| Withdraw proposed assumption | Authenticated authoring agent | Proposed lifecycle and record CAS; citation CAS/removal when cited in the draft; writable amendment when frozen history cites it |
| Supersede disposed assumption | Authenticated authoring agent | Amendment draft, lineage/idempotency, record and citation CAS |
| Cite/uncite | Authenticated authoring agent | Named revision is the current draft and citation CAS |
| Answer question | Human | Open lifecycle and record CAS |
| Dispose assumption | Human | Proposed lifecycle, record CAS, and citation CAS when cited in a draft |

Agent identity is transport-derived. The service checks `actor.kind ===
"agent"`; it never compares `actor.conversationId` with creation provenance.
Human-only acts check `actor.kind === "human"` inside the service even when the
route already enforces it.

One abandoned-spec guard covers creation, answer, disposition, edit,
withdrawal, supersession, cite, and uncite. Studio read-only presentation is not
the invariant.

### 5.3 Compare-and-swap contract

Questions and assumptions have `record_version INTEGER NOT NULL CHECK
(record_version > 0)`, starting at 1. Every row mutation uses a guarded update
whose predicate includes the expected version and legal source lifecycle, and
increments the version exactly once.

Each revision has `citation_version INTEGER NOT NULL CHECK (citation_version >
0)`, starting at 1. A transaction that changes any citation triple or refreshes
any cited assumption snapshot increments it exactly once and recomputes the
citation hash. A no-op does not increment it.

Add these typed refusal codes:

| Code | Meaning | Required recovery |
| --- | --- | --- |
| `authoring_agent_required` | A human or untrusted transport attempted an agent correction | Run from an authenticated authoring conversation |
| `stale_attention_record` | `recordVersion` no longer matches | Re-read `Qn`/`An` and reconsider the mutation |
| `stale_citation_set` | `citationVersion` no longer matches | Re-read the draft citation set and reconsider the mutation |
| `attention_state_conflict` | Lifecycle or supersession no longer admits the act | Read the current record and use the capability named by the refusal |
| `idempotency_conflict` | A supersession operation id was reused with different input | Use the original payload or a new operation id |

Continue using `amendment_required`, `not_found`, and `validation` for their
existing meanings. Every refusal names the mechanism and the exact next command
or human act. Logs and receipts include versions and ids, never question,
assumption, answer, or reason bodies.

### 5.4 Current, active, and history projections

Repository reads remain complete. Public projections derive three explicit
sets:

- **current records:** all records except withdrawn rows and superseded
  predecessors;
- **active attention:** current questions in `open` and current assumptions in
  `proposed`; and
- **record history:** withdrawn rows and superseded predecessors.

Answered questions and human-disposed assumptions remain current durable facts;
they are not active attention. Handle lookup, detail, History, and export retain
all rows. Status, Needs You, and Q/A badges count only active attention.

Active attention is not itself a sign-off blocker. The canonical lint finding's
`blocks_signoff` flag remains authoritative; for example, a rejected cited
assumption blocks, while an open question or proposed assumption remains visible
attention. Review and Q/A must remove their current client-only blanket blocker
logic and consume that server result.

Each detail record also carries server-derived presentation data:

```ts
{
  state: "current" | "history";
  attentionActive: boolean;
  lastMutation: {
    operation: SpecReviewRecordOperation;
    actor: ActorProvenance;
    occurredAt: string;
  } | null;
  humanCapability:
    | { kind: "answer" | "dispose"; allowed: true }
    | {
        kind: "answer" | "dispose";
        allowed: false;
        code: "terminal" | "amendment_required" | "read_only";
        blockingRevisionId: string | null;
        instruction: string;
      }
    | null;
}
```

`lastMutation` comes from the latest typed record event, never from
`updated_at`; it is null for pre-cutover records with no truthful typed event.
Studio renders actions from `humanCapability` rather than reimplementing frozen
citation and abandoned-spec rules in React.

## 6. Persistence design

### 6.1 Question and assumption rows

Rebuild `spec_questions` with:

```text
record_version  INTEGER NOT NULL DEFAULT 1 CHECK (record_version > 0)
status          open | answered | withdrawn
withdrawn_at    TEXT NULL
```

Retain the stable id, spec, number, display attachment, text, creation
provenance, answer fields, and timestamps. Add the lifecycle cross-field
`CHECK` described in §5.1.

Rebuild `spec_assumptions` with:

```text
record_version                 INTEGER NOT NULL DEFAULT 1
disposition                    proposed | confirmed | rejected | deferred | withdrawn
withdrawn_at                   TEXT NULL
supersedes_assumption_id       TEXT NULL
supersession_operation_id      TEXT NULL
supersession_request_hash      TEXT NULL
```

Constraints:

- the predecessor belongs to the same spec through a composite foreign key;
- `id != supersedes_assumption_id`;
- one non-null successor per predecessor;
- one non-null supersession operation id per spec;
- operation id and request hash are both null or both present;
- only a successor row carries operation metadata; and
- the lifecycle cross-field checks in §5.1 apply.

The rebuild adds the composite unique keys required by those same-spec foreign
keys; the citation table likewise references `(revision_id, spec_id)` and
`(assumption_id, spec_id)`, not ids whose ownership is checked only in
application code.

Service admission permits a predecessor only when it is `confirmed`,
`rejected`, or `deferred`, is not already superseded, and predates the new row.
Because the service creates the successor after resolving the predecessor and
the edge never changes, cycles are unrepresentable. A withdrawn or still
proposed assumption is edited or withdrawn, not superseded.

### 6.2 Revision citation relation

Add `spec_revision_assumption_citations`:

```text
revision_id              TEXT NOT NULL
spec_id                  TEXT NOT NULL
element_id               TEXT NOT NULL
assumption_id            TEXT NOT NULL
assumption_snapshot_json TEXT NOT NULL
created_at               TEXT NOT NULL
updated_at               TEXT NOT NULL

PRIMARY KEY (revision_id, element_id, assumption_id)
FOREIGN KEY (revision_id, spec_id)
  REFERENCES spec_revisions(id, spec_id) ON DELETE CASCADE
FOREIGN KEY (revision_id, element_id)
  REFERENCES spec_element_versions(revision_id, element_id) ON DELETE CASCADE
FOREIGN KEY (assumption_id, spec_id)
  REFERENCES spec_assumptions(id, spec_id)
```

The revision and assumption tables expose `UNIQUE(id, spec_id)` for the
composite references. A citation trigger additionally checks that the referenced
`spec_elements.spec_id` equals the row's `spec_id`; the existing element-version
table does not duplicate spec id. The repository performs the same checks to
return domain refusals. Add indexes for `(revision_id, assumption_id)` and
`(assumption_id, revision_id)`.

Database triggers refuse citation-row insert, update, or delete when the owning
revision is not `draft`. A revision trigger also refuses changes to citation
contract/version/hash when the old revision state is not `draft`. The service
and repository still check state to return a typed refusal; triggers are the
corruption backstop for future call sites.

`assumption_snapshot_json` strictly parses this versioned shape:

```ts
type AssumptionCitationSnapshotV1 = {
  schemaVersion: 1;
  captureKind: "native" | "legacy_backfill";
  capturedAt: string;
  assumptionId: string;
  number: number;
  recordVersion: number;
  text: string;
  elementId: string | null; // display attachment, not citation authority
  proposedBy: ActorProvenance;
  disposition:
    | "proposed"
    | "confirmed"
    | "rejected"
    | "deferred"
    | "withdrawn";
  disposedAt: string | null;
  withdrawnAt: string | null;
  supersedesAssumptionId: string | null;
  createdAt: string;
  updatedAt: string;
};
```

The reverse `supersededBy` relation is deliberately absent. It is derived from
the successor row and is not part of the premise observed by a revision.

### 6.3 Revision integrity fields

Add to `spec_revisions` and its public schema:

```text
citation_contract_version  INTEGER NOT NULL CHECK (... IN (1, 2))
citation_version           INTEGER NOT NULL CHECK (... > 0)
citation_hash              TEXT NOT NULL
```

Canonical citation order is `elementId`, then `assumptionId`. The citation hash
is:

```ts
sha256(stableStringify({
  citationContractVersion,
  citations: sortedCitations.map(({ elementId, assumptionId, snapshot }) => ({
    elementId,
    assumptionId,
    snapshot,
  })),
}));
```

The existing `content_hash` remains the hash of authoring stage and canonical
elements. Revision integrity is now the explicit tuple:

```text
(content_hash, citation_contract_version, citation_hash)
```

This preserves the meaning of existing element hashes while making citation
tampering detectable. Proposal, approval, import, export, and verification must
validate the whole tuple.

### 6.4 Citation contract versions

- Existing **proposed, approved, and withdrawn** revisions become contract 1,
  `legacy_element_only`. Their backfilled citation hash records cutover state,
  but does not claim a human reviewed a citation fingerprint that did not
  exist.
- Existing **draft** revisions become contract 2. A draft has no frozen review
  basis, so allowing it to proceed under the legacy contract would create a new
  post-cutover approval that still ignored citations.
- Every new revision, including born-approved imports, uses contract 2.

A contract-1 element approval may carry to the first contract-2 amendment only
when the covered subject has unchanged element payloads and no citations on
either side. Otherwise it is pending with reason `legacy approval did not
fingerprint assumption citations`. Revision sign-off never carries. Imported
settlement remains a distinct non-approval basis.

## 7. Citation behavior

### 7.1 Revision paths

Every revision path has an explicit rule:

| Path | Citation behavior |
| --- | --- |
| New empty draft | Start contract 2 with an empty set, version 1, and its hash |
| Amendment or other draft fork | Copy base triples and snapshots atomically; target is contract 2 |
| Request Changes | The new draft copies the withdrawn proposal's exact citations |
| Attached assumption created in a draft | Create record and citation together; one transaction |
| Spec-level assumption | Create no citation |
| Born-approved import | Create an unobservable draft row inside the import transaction, materialize citations, verify/hash/lint, then finalize it to approved before commit |
| Element removed from draft | Cascade/remove that element's citations in the same edit receipt |
| Element reintroduced | Do not restore citations implicitly |
| Proposal | Verify content and citation hashes, then freeze both |

`cctl spec assume --element <handle>` requires a current draft. If none exists,
it refuses with the command that opens or returns to a draft. Plain spec-level
`assume` remains available without manufacturing a citation.

### 7.2 Edit and withdrawal

A question edit changes `text` and/or display attachment. An assumption edit
changes `text` and/or display attachment while it remains proposed.

When an assumption text changes, every citation to it in the current draft gets
a newly captured snapshot in the same transaction. This requires the current
`citationVersion` and increments it once. Frozen snapshots never change.

Display attachment is independent of citation truth. An assumption edit that
changes attachment must include an explicit citation intent:

```ts
type CitationIntent =
  | { kind: "preserve" }
  | {
      kind: "replace";
      revisionId: string;
      elementHandles: string[]; // exact resulting set for this assumption
    };
```

`preserve` explicitly acknowledges that display attachment and citations may
differ. `replace` removes the assumption's current draft triples and creates
the exact named set. Omission while changing attachment is refused; the server
never infers a retarget.

Withdrawing an assumption removes all of its current-draft citations in the
same transaction. If any frozen revision cites it, an amendment draft must
exist first. The copied draft is where the withdrawal removes current truth;
older snapshots remain unchanged. Withdrawal of an uncited assumption changes
only the record.

### 7.3 Human disposition

The first human disposition of a proposed assumption is legal and uses record
CAS. If the current draft cites it, the transaction refreshes those citation
snapshots and requires citation CAS. If a frozen revision cites it and no
amendment draft exists, return `amendment_required`; the review attempt must be
ended and a draft opened before the premise can acquire a new observed state.

Studio must not offer a disposition request that the service will necessarily
refuse. It displays an amendment-required explanation and directs the operator
to Review when a frozen citation has no writable draft.

A second human disposition is always `attention_state_conflict`. Correcting a
human-disposed assumption uses supersession.

### 7.4 Supersession

`supersede` requires a current amendment draft, predecessor `recordVersion`,
draft `citationVersion`, and a payload:

```ts
type SupersedeAssumptionPayload = {
  operationId: string;
  reason: string;
  text: string;
  attachment:
    | { kind: "spec" }
    | { kind: "element"; handle: string };
  citations:
    | { kind: "clear" }
    | { kind: "replace"; elementHandles: string[] };
};
```

The transaction:

1. verifies the disposed predecessor, versions, draft, and every target
   element;
2. creates one proposed successor with the next stable `An` handle;
3. removes all predecessor citations from the draft;
4. creates successor citations for the exact replacement set;
5. increments the predecessor record version and draft citation version;
6. appends a `superseded` predecessor event, a `proposed` successor event, and
   the citation event;
7. appends bounded predecessor-inactive and successor-active attention
   invalidations; and
8. publishes invalidation only after commit.

`supersession_request_hash` covers the canonical payload, predecessor, and
draft revision. A retry with the same operation id and hash returns the existing
successor, `idempotentReplay: true`, and the current record/citation versions
without allocating another handle or reapplying citation mutations. Reusing the
operation id with different input returns `idempotency_conflict`. A different
operation against an already superseded predecessor returns
`attention_state_conflict` and names the successor.

### 7.5 Cite and uncite

`cite` and `uncite` name one assumption, one element, one draft revision, and
the expected citation version. The service validates current-draft identity,
same-spec ownership, element membership in that revision, and assumption
eligibility.

Proposed, confirmed, and deferred assumptions may be cited. Rejected,
withdrawn, and superseded assumptions may not gain a citation; their recovery
is uncite or supersede. Removing a triple does not alter the display attachment.

## 8. Integrity, review, and export

### 8.1 Snapshot and lint

`SpecRevisionSnapshot` gains sorted `assumptionCitations` and the revision view
gains citation contract/version/hash. `toLintSnapshot` reads only these rows.
It never scans current assumptions by `element_id`.

For each cited row, lint uses the frozen snapshot's handle and disposition.
Rejected cited premises keep their existing sign-off-blocking finding. A later
global edit, withdrawal, or supersession cannot change an older lint result.

### 8.2 Semantic diff

Revision diff emits deterministic entries for:

- citation added;
- citation removed;
- citation moved, represented as remove plus add;
- cited snapshot changed; and
- citation contract boundary.

A citation-only amendment is never reported as unchanged. Text rendering names
the assumption handle, subject handle, before/after lifecycle where relevant,
and never substitutes the mutable current row for either side.

### 8.3 Approval applicability

Augment each existing approval-subject fingerprint with:

- `citationContractVersion`; and
- a subhash of citations for every element covered by that subject.

Requirement approval continues to cover the requirement and its criteria;
their combined citation subhash is part of that subject. Decision approval uses
the decision's citation subhash. Revision sign-off binds the full citation hash.

Citation add, removal, or snapshot update therefore invalidates only affected
item approvals plus revision sign-off. Unrelated item approvals may carry.
Contract-1 carry follows §6.4. Import settlement stays separately attributed
and is never labelled as a carried human approval.

### 8.4 Canonical export, strict decoding, and verification

Bump the canonical bundle format. Export includes:

- complete question and assumption rows, including versions, withdrawal, and
  supersession metadata;
- sorted revision citation rows and their strict snapshots;
- citation contract/version/hash on every revision; and
- only the two Q/A audit event families, ordered by durable event id, rather
  than unrelated spec events.

Canonical bundle consumption is read-only. The only supported consumer is the
local decoder used by `cctl spec verify --against <bundle>`; it never creates or
restores persistent spec state. The decoder runs before any server request or
write and performs these checks in order:

1. Strictly decode the outer `{ markdownFiles, manifest }` structure and parse
   the manifest JSON. A parseable manifest with a missing or non-format-4
   discriminator fails with `bundle_format_mismatch` immediately.
2. Strictly decode the complete format-4 manifest. Unknown, missing, or invalid
   fields fail at their precise structural path rather than being discarded or
   defaulted.
3. Recalculate element payload hashes, content hash, citation hash, same-spec
   foreign relations, citation element membership, lifecycle consistency,
   supersession uniqueness, and event-family, payload, and event-id ordering
   constraints.
4. Canonically re-render the decoded manifest and every revision Markdown file.
   Compare the manifest string byte-for-byte and the Markdown array
   structure-for-structure: exact ordered paths, no missing, extra, duplicate,
   or reordered entry, and exact content bytes.

Format discrimination reports `bundle_format_mismatch`; structural, semantic,
hash, and canonical-render mismatches report the precise integrity category and
path without echoing question, assumption, answer, or reason bodies. After the
local bundle passes, verification may fetch and integrity-check the current
durable spec, render its format-4 bundle, and compare it with the decoded local
canonical bundle.

There is no canonical persistent restore/import surface, old-format reader,
conversion, dual write, shape inference, or fallback. The existing
`cctl spec import` command remains the separate external-source authoring import
that creates a born-approved spec from its own bundle schema; it must reject a
canonical export bundle rather than treating it as restoration input.

## 9. Service and event architecture

### 9.1 Repository boundary

Keep transaction ownership in `SpecsRepo.transaction`. Replace broad Q/A
upserts for mutations with repository operations that express the invariants:

```ts
updateOpenQuestion(input): CasOutcome<SpecQuestionRow>
updateProposedAssumption(input): CasOutcome<SpecAssumptionRow>
answerOpenQuestion(input): CasOutcome<SpecQuestionRow>
disposeProposedAssumption(input): CasOutcome<SpecAssumptionRow>
insertAssumptionSuccessor(input): IdempotentSupersessionOutcome
readRevisionCitations(revisionId): SpecAssumptionCitation[]
replaceAssumptionDraftCitations(input): CitationCasOutcome
mutateDraftCitation(input): CitationCasOutcome
```

Creation may retain insert methods, but identity/provenance/creation fields are
not updateable through a generic save. Repository outcomes distinguish stale
version, illegal lifecycle, uniqueness conflict, and success without parsing
SQLite error text in the service.

### 9.2 Application service operations

Expose:

- `editAttentionRecord`;
- `withdrawAttentionRecord`;
- `supersedeAssumption`;
- `citeAssumption`;
- `unciteAssumption`; and
- the existing create, answer, and dispose operations with the new common
  guards and version inputs.

The service resolves handles, authorization, lifecycle, amendment needs, and
refusal copy. The repository performs the guarded mutation. Row mutation,
citation mutation, audit append, and revision hash/version update commit or
roll back together.

### 9.3 Durable audit events

Add two strict `spec_events` payload families.

`spec-review-record-mutated` version 1 records:

```ts
{
  schemaVersion: 1,
  recordKind: "question" | "assumption",
  recordId: string,
  recordNumber: number,
  attentionId: string, // the stable record id
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
  active: boolean,
  successorAssumptionId?: string,
  before: RecordAuditSnapshot | null,
  after: RecordAuditSnapshot
}
```

`RecordAuditSnapshot` is a strict record-kind union. Its common fields are
record version, text, display attachment, lifecycle, and both supersession
directions as resolved at the event. The question member carries answer,
answered-at, and withdrawn-at; the assumption member carries disposition,
disposed-at, and withdrawn-at. `before` is null only for opened, proposed, or
imported records. Reason is required for withdrawal and supersession. New record
creation and import paths append this event as well as the bounded invalidation
event, so the History tab does not have to invent creation events from row
timestamps. Supersession appends one record event for the predecessor and one
for the newly proposed successor.

Pre-cutover rows cannot acquire a truthful terminal actor retroactively. The
migration does not fabricate audit events. Their detail and canonical export
remain complete from the row, while History labels mutation coverage as
starting at the cutover instead of guessing earlier actors.

`spec-assumption-citations-mutated` version 1 records revision id, citation
version/hash before and after, and sorted added, removed, and refreshed triples.
Supersession appends both event types atomically.

The existing `spec-attention-changed` signal remains the bounded SSE
invalidation event. It does not become audit truth. Operational logger events
use stable names under the existing `specs.review` and `state-store.specs`
modules and include only ids, operation, versions, counts, outcome/refusal code,
and duration. They never include record, answer, or reason content.

## 10. Agent command design

### 10.1 Command family

```text
cctl spec attention edit <slug> <Qn|An> \
  --file <update.json> --if-version <n> [--if-citation-version <n>]

cctl spec attention withdraw <slug> <Qn|An> \
  --reason-file <reason.md> --if-version <n> [--if-citation-version <n>]

cctl spec attention supersede <slug> <An> \
  --file <successor.json> --if-version <n> --if-citation-version <n>

cctl spec attention cite <slug> <An> --element <handle> \
  --revision <draft-id> --if-citation-version <n>

cctl spec attention uncite <slug> <An> --element <handle> \
  --revision <draft-id> --if-citation-version <n>
```

The edit file is a strict discriminated union:

```ts
type QuestionEdit = {
  kind: "question";
  text?: string;
  attachment?: { kind: "spec" } | { kind: "element"; handle: string };
};

type AssumptionEdit = {
  kind: "assumption";
  text?: string;
  attachment?: { kind: "spec" } | { kind: "element"; handle: string };
  citationIntent?: CitationIntent;
};
```

At least one mutable field is required. Changing assumption attachment requires
`citationIntent`; changing cited assumption text requires
`--if-citation-version`. The CLI performs a read preflight and names a missing
token before making the write, but the server remains authoritative.

### 10.2 Reads and receipts

`cctl spec get <slug>/<Qn|An>` and bounded attention projections expose:

- `recordVersion`;
- lifecycle and derived current/active/history state;
- creation and last-mutation provenance;
- predecessor and successor handles;
- current draft id, citation version/hash; and
- exact current-draft citation triples for an assumption; and
- the server-derived `humanCapability`, including `amendment_required` and its
  target/recovery instruction when disposition is not currently admissible.

Mutation text and JSON receipts include the record handle/id, previous and new
record versions, lifecycle, draft revision, previous and new citation versions,
added/removed/refreshed subject handles, and idempotent replay status. They do
not echo bodies by default. JSON remains strict and text output names the exact
follow-up read.

Command help leads with creation commands, then links to `spec attention` when
a record becomes obsolete. Guidance must never instruct an agent to reject an
assumption or use Q/A as a design-notes bucket.

## 11. Spec Studio UI proposal

The UI is an **attention register**, not an authoring surface. It keeps one
Questions & Assumptions view, separates current truth from record history, and
removes duplicated mutations from the Overview rail.

### 11.1 Desktop layout

```text
QUESTIONS & ASSUMPTIONS
Resolve requirement-stage unknowns and premises.
Design remains locked until the requirements stage is settled.

┌─ QUESTIONS · 1 OPEN ───────────────┐ ┌─ ASSUMPTIONS · 1 PROPOSED ─────────┐
│ Q3  OPEN  ATTACHED TO R1    [Copy] │ │ A8  PROPOSED  ATTACHED TO R3 [Copy]│
│ CLAUDE AGENT · Aug 22 · Open conv. │ │ CLAUDE AGENT · Aug 22 · Open conv. │
│ Which failure contract applies?    │ │ Cache invalidation may lag…         │
│                                    │ │ Supersedes A4 · Cited by R3         │
│ ANSWER                             │ │ DISPOSITION                         │
│ ┌────────────────────────────────┐ │ │ ○ Confirm  ○ Reject  ○ Defer       │
│ │                                │ │ │                    [Record decision]│
│ └────────────────────────────────┘ │ └─────────────────────────────────────┘
│                    [Record answer] │
└────────────────────────────────────┘

▸ RECORD HISTORY · 2
```

At `max-md`, Questions, Assumptions, and Record history stack in that document
order. Metadata wraps before actions, the radio choices stack, and submit
controls become full width. At 390px and 200% zoom the view has no horizontal
scrolling and all interactive targets remain at least 44 by 44 CSS pixels.

### 11.2 Partition and order

- Questions: open first, then answered; each bucket sorts by number.
- Assumptions: proposed first, then confirmed, rejected, deferred; each bucket
  sorts by number.
- Record history: withdrawn records and superseded predecessors, newest
  terminal/supersession event first, handle as tie-breaker.
- An empty history renders `RECORD HISTORY · 0` as text, not an empty
  interactive disclosure.

Answered and human-disposed records stay in the current columns because they
remain the durable answer/premise. Withdrawn or superseded records are history.

### 11.3 Record cards

Each card is a labelled `<article id={handle} tabIndex={-1}>` with a real
heading. The header contains handle, lifecycle `StatusChip`, display attachment,
optional `Blocks sign-off`, and `CopyReferenceControl`.

Extract the backend-aware actor, `<time dateTime>`, and unique conversation-link
treatment already proven by `SpecCommentThread` into a feature-local
`SpecActorAttribution`. Creation and latest mutation remain distinguishable;
legacy invalid provenance renders `Unknown author` without inventing identity.

Display attachment and current-draft citations are separate lines. Lineage uses
deep links: **Supersedes A4** and **Superseded by A8**. A rejected cited
assumption shows a red **Blocks sign-off** chip plus the valid next act; it does
not offer a human correction button.

### 11.4 Human actions

- An open question uses a multiline Markdown answer and one **Record answer**
  button. The submitted request carries `recordVersion`.
- A proposed assumption uses `RadioGroup` for Confirm, Reject, or Defer, then
  one explicit terminal button whose label and tone match the selection.
- Answered, disposed, withdrawn, and superseded records have no controls.
- When a frozen citation requires an amendment, replace controls with an amber
  explanation and a link to Review.
- Mutations return Promises. Pending, error, and success state is card-local.
  Failure uses `role="alert"` and preserves the answer and selection; success
  uses `role="status"` and restores focus to the record heading/status.

Use existing `Button`, `StatusChip`, `RadioGroup`, `Collapsible`,
`MultilineInput`, `CopyReferenceControl`, and `CompactMarkdown`. Add no token,
global CSS, or shared primitive.

### 11.5 History, deep links, Review, and Overview

Use controlled `Collapsible` for non-empty Record history. A target such as
`?el=A4` opens history before the existing focus observer runs, mounts the card,
then focuses it.

The separate History tab reads typed durable mutation events and gains an
**Attention records** filter. It shows actor, time, operation, before/after
fields, and a subject deep link; it does not synthesize events from current-row
timestamps.

Review consumes the named revision's citation snapshots. It excludes current
withdrawn/superseded records and never reconstructs a revision premise from the
mutable spec-wide assumption map.

Remove disposition mutations from the Overview structure rail, including its
undersized controls. The rail remains a compact read-only status summary with
its existing **Open** link to the Questions & Assumptions view.

Keep the phase stepper and requirements → design lock unchanged. Do not add a
design-notes region or any UI path for design work during requirements.

### 11.6 Storybook and accessibility acceptance

After Alex approves this proposal, add focused attention-record stories plus
aggregate page stories:

| Story | Proof |
| --- | --- |
| `EditedOpenQuestion` | Current text, mutation actor/time, conversation link, answer form |
| `AgentProposedAssumption` | Backend attribution, attachment, citations, lineage |
| `HumanDisposedAssumption` | Three terminal outcomes and no controls |
| `WithdrawnRecord` | Reason, actor/time, history treatment |
| `SupersessionChain` | Reciprocal deep links and current/history partition |
| `RecordHistoryCollapsed` / `Expanded` | Disclosure semantics and stable focus |
| `EmptyHistory` | Visible zero state without an empty control |
| `MutationPending` | Only the target card is busy |
| `MutationFailureRetainsDraft` | Alert and preserved answer/selection |
| `ImportedAndLegacyProvenance` | Honest import/unknown attribution |
| `AbandonedReadOnly` | Complete records, no mutation controls |
| `HistoricalDeepLink` | History opens before `A4` focus |
| `RevisionPinnedCitation` | Review shows frozen rather than current premise |
| `Mobile390` | Reflow, wrapping, 44px targets |
| `RequirementsStage` | Phase stepper keeps Design locked |

Each story uses `a11y: { test: "error" }`. Play tests cover keyboard radio
selection, multiline submission, failure retention, disclosure Enter/Space,
deep-link focus, and terminal-control absence. Verify `Mobile390` at actual 200%
browser zoom and run axe.

## 12. Migration and cutover

Implement migration `0034-native-sdd-attention-citations` and bump
`KNOWN_SCHEMA_VERSION` from 10 to 11.

This is a quiesced cutover. The schema barrier prevents an old process from
opening an upgraded database; it cannot evict a connection that was already
open. Deployment therefore has a hard prerequisite: stop every older Command
Center process sharing the database before running the migration, and do not
restart one afterward.

The migration sequence is:

1. Acquire the existing migration/write lock and publish the version-11
   compatibility barrier.
2. Preflight every Q/A row for lifecycle contradictions, invalid provenance,
   cross-spec attachments, duplicate handles, and impossible timestamps. Stop
   with bounded offending ids; do not normalize silently.
3. Rebuild the authoritative question and assumption tables with the new
   columns, enums, foreign keys, indexes, and cross-field checks. Update the
   authoritative synchronous schema floor as well as the migration; do not
   treat the disabled duplicate DDL block as authority.
4. Add revision citation metadata, the citation table, and indexes. Do not
   install the non-draft mutation triggers until frozen backfill is complete.
5. Backfill record version 1.
6. Materialize old inferred citations exactly: for drafts, include every
   attached assumption whose element is in the draft; for frozen revisions,
   also apply the existing `created_at <= proposed_at` cutoff. Capture current
   cutover state as `legacy_backfill`; older states cannot be reconstructed.
7. Assign contract 1 to frozen revisions and contract 2 to drafts, then write
   citation version 1 and each citation hash without changing content hashes.
8. Verify every row, relation, lifecycle, content hash, citation hash, and
   contract assignment.
9. Install the non-draft citation-row and revision-metadata mutation triggers,
   verify they refuse a rolled-back probe, and commit the migration ledger
   entry.
10. Start only version-11 processes and run a post-open integrity scan.

The migration is idempotent before and after completion and leaves no state in
which new lifecycle values can be written without the new reader. A preflight
or verification failure rolls back the database mutation and retains the
barrier diagnostic needed for recovery.

## 13. Implementation plan

Implementation follows red-green-refactor. Each loop runs the registered test
command against one explicit test file:

```text
cctl validate run test --queue-if-busy -- path/to/file.test.ts
```

Wider changed-scope runs occur only at checkpoints.

### Phase 0 — Formal Native SDD amendment

1. Amend `.kiro/specs/native-sdd/requirements.md` with the lifecycle,
   authorization, frozen-citation, correction, history, migration, UI, and
   stage-separation requirements in this design.
2. Lint and obtain human approval of requirements.
3. Amend `.kiro/specs/native-sdd/design.md`, preserving the decisions here.
4. Validate and obtain human approval of design.
5. Amend `.kiro/specs/native-sdd/tasks.md` into the phases below and obtain
   human approval before implementation.

### Phase 1 — Schemas and migration

1. Add failing schema tests for legal/illegal Q/A states, successor constraints,
   strict citation snapshots, revision citation metadata, event payloads, and
   refusal codes in `src/lib/specs/schemas.test.ts`.
2. Add a failing `0034-native-sdd-attention-citations.test.ts` covering
   preflight refusal, atomic rebuild/backfill, exact legacy projection,
   draft/frozen contract assignment, triggers, idempotency, rollback, and the
   version barrier.
3. Implement schema 11, the migration registry entry, authoritative floor DDL,
   and Zod schemas minimally; refactor only after both focused files are green.

### Phase 2 — Guarded repository and citation integrity

1. In `spec-review-repo.contract.test.ts`, reproduce broad-upsert corruption,
   stale record writes, second terminal acts, successor races, and idempotent
   retry; then replace mutation upserts with guarded operations.
2. In the SpecsRepo contract tests, add empty/copy/remove/replace citation-set
   behavior, non-draft trigger refusal, CAS, sorting, snapshot parsing, and hash
   verification; then add repository support and extend
   `SpecRevisionSnapshot`.
3. Add failing focused tests to `revision-diff.test.ts` and
   `approval-applicability.test.ts` for citation-only changes, snapshot updates,
   affected-subject invalidation, unrelated carry, and contract-1 boundaries;
   then implement the smallest domain changes.

### Phase 3 — Service transactions and revision paths

1. Extend `review-service.questions.test.ts` first with later-conversation edit
   and withdrawal, human transport refusal, stale CAS, abandoned guard, terminal
   immutability, first disposition, amendment requirement, supersession retry,
   and atomic rollback.
2. Implement the common guard and five attention operations. Do not compare
   creator conversation ids.
3. Add one failing test per revision-opening/removal path before changing it:
   ordinary continuation, explicit amendment, Request Changes, link entry,
   element removal, proposal, and born-approved import.
4. Make each path own citation copy/materialization/removal and the integrity
   tuple. Verify frozen snapshots remain byte-for-byte unchanged.

### Phase 4 — Routes, projections, export, and CLI

1. Add route tests first for server-derived actor provenance, agent/human
   admission, versioned request/receipt shapes, typed refusals, and complete
   current/history views.
2. In `src/lib/specs/export.test.ts`, add failing tests for the format-4 bump,
   strict decoding, deterministic event/citation order, canonical
   decode/re-render equality, precise structural and semantic tamper detection,
   and missing/old-format refusal; then implement the read-only decoder beside
   the canonical renderer in `src/lib/specs/export.ts`. In
   `src/cli/commands/spec/read.contract.test.ts`, prove `verify --against`
   rejects locally before network or write, then wire the decoder into the read
   command. In `src/cli/commands/spec/import.test.ts`, pin that the separate
   external-source import rejects canonical export shape.
3. Add CLI help/contract tests first for progressive disclosure, strict file
   payloads, missing-token preflight, refusal recovery, idempotent replay, and
   non-echoing receipts; then implement `spec attention`.
4. Update authoring guidance tests so obsolete records point to correction
   commands and no instruction suggests human rejection or premature design.

### Phase 5 — Spec Studio prototype and implementation

This phase begins only after Alex approves the UI proposal in §11.

1. Build the focused Storybook state matrix without production mutations and
   review desktop, 390px, and 200% zoom. Story scaffolding is visual-only and
   does not need an artificial failing test.
2. Add failing component tests for current/history partition, terminal-control
   absence, record CAS submission, radio/commit behavior, card-local async
   state, draft retention, provenance links, and history deep-link focus.
3. Implement the attention register with existing primitives and a
   feature-local actor attribution component.
4. Add failing page tests before removing Overview mutations, replacing
   revision Review data, and switching History to durable events.
5. Run Storybook play/axe checks and a real keyboard pass after tests are green.

### Phase 6 — Integrated cutover verification

1. Run changed-scope test, typecheck, lint, format, and build validations.
2. On a scratch database, exercise the full live flow: create attached
   assumption, propose, Request Changes, dispose, supersede, retarget, propose,
   approve, export, verify, restart, and re-read.
3. Prove an older binary refuses schema 11 and never writes to it.
4. Query structured logs by trace id and verify mutation/event/version fields,
   absence of content bodies, and one commit/invalidation per act.
5. Verify durable round trips after restart: current/history partition,
   lineage, frozen old snapshot, new revision snapshot, hashes, approvals, and
   audit events.

## 14. Acceptance matrix

| Behavior | Required evidence |
| --- | --- |
| Later agent conversation edits open record | Service + route + CLI test with different conversation id |
| Creator provenance does not authorize | Same actor-kind behavior regardless of creator id |
| Human cannot edit/withdraw | Service-level refusal, not UI absence alone |
| Agent cannot answer/dispose | Service-level refusal |
| Stale record/citation writers lose | Guarded repository and service tests |
| Exactly one terminal act wins | Concurrent answer/disposition test |
| Disposed assumption remains immutable | Update refusal plus successor success |
| Ambiguous supersede retry is idempotent | Same operation returns same handle and versions |
| Frozen citations never change | Before/after byte comparison across amendment |
| Citation-only amendment is visible | Diff, integrity, lint, and export tests |
| Approval carry prices citations | Affected pending; unrelated carried; legacy boundary covered |
| Every draft path owns citations | Fork/import/removal path matrix |
| Withdrawn/superseded leave attention | Status, Needs You, and badge tests |
| History and export retain all records | Projection, UI, canonical decode/re-render equality, and verification |
| Review uses revision snapshot | Current row mutation cannot alter old Review output |
| Stage separation remains visible | Requirements-stage story and guidance test |
| No compatibility behavior exists | Old-process barrier and old-bundle refusal tests |
| UI is operable at mobile/zoom | Storybook, keyboard, axe, and browser verification |

## 15. Risks and containment

| Risk | Containment |
| --- | --- |
| Backfill falsely claims historical state | Mark snapshots `legacy_backfill`; contract 1 never claims citation-aware approval |
| One revision path omits citations | Central draft-fork primitive plus path matrix tests |
| Direct SQL mutates frozen citations | Repository checks plus database triggers |
| Attachment silently retargets review truth | Required explicit citation intent |
| Human overwrites a terminal judgment | Lifecycle predicate plus record CAS |
| Retry creates multiple successors | Operation id/hash and unique predecessor |
| Already-open old process writes after migration | Mandatory fleet quiescence before cutover |
| UI displays current premise as historical | Review consumes revision snapshot only |
| Audit leaks authored content into diagnostic logs | Content stays in durable audit/export; operational logs carry ids/versions/counts only |

## 16. Completion boundary

This slice is complete only when schema 11 is the sole supported database
contract, every revision path carries citation authority, the live correction
and supersession flow survives restart/export/verify, and Spec Studio renders
the same frozen premise the selected revision actually reviewed.

The next ticket slice may then address the remaining `cctl spec` operability and
approval-request/ledger work without depending on mutable global assumption
inference.
