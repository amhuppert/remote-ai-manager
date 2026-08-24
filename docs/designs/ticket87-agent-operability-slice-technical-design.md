# Native SDD agent operability slice technical design (command-center#87)

Status: APPROVED — approved by Alex on 2026-08-24; implemented and validated
Date: 2026-08-24
Scope: current-only element reads with an explicit revision selector, narrow
section reads, prose-handle lint, immutable-parent refusals, the propose
coordinator with automatic approval requests, the two-sided approval ledger,
refusal rationale, and the agent guidance surface

## 1. Outcome

Native SDD removes the remaining agent-interface traps that made the reported
run waste work, without touching the durable spec model:

- an ordinary `cctl spec get` can never silently answer a current authoring
  question with content from a withdrawn revision; historical reads are
  explicit;
- sections — the most-edited prose and today the only content with no read
  path — become narrowly readable without inventing a second handle
  vocabulary;
- prose cross-references to handles participate in dangling-handle lint, so a
  renumbered element can no longer ship a wrong reference through a clean
  lint;
- an attempted parent change is refused with the rule and the legitimate next
  act, instead of returning success and silently doing nothing;
- a successful proposal files its gate-scoped approval request itself,
  idempotently, and a notification failure degrades to a typed delivery
  outcome instead of converting proposal success into a 5xx;
- status, proposal, reopen, and withdrawal receipts report both sides of the
  approval ledger — carried, current-revision, import-settled, combined-act,
  and pending — so an agent stops mispricing the reopen loop; and
- flagship designed-constraint refusals state *why* the rule exists at the
  point of refusal, and the authoring skill classifies designed versus
  incidental friction so agents stop reporting the product as a defect.

This slice is read-path, projection, coordination, and guidance work. It adds
**no table, no column, no migration, and no schema-version bump**. Every change
is additive application vocabulary (refusal codes, view fields, one route, one
CLI subfamily) cut over atomically with its consumers.

## 2. Governing inputs and decisions

This design refines the third slice of
`docs/designs/ticket87-native-sdd-ui-comments-and-attention.md` and is
authoritative for that slice where it is more specific. It is based on the
Native SDD reflection attached to command-center#87, the parent design's §6,
and the current implementations of the spec read routes, lint, authoring and
review services, approval projection, and CLI registry.

Settled decisions for this slice:

1. **Reads are current-only by default.** Historical archaeology is a stated
   intent, never a fallback. The write-side analogue (`historical_element_id`)
   already behaves this way; the read side catches up.
2. **No second handle vocabulary.** Sections stay handle-less and are read by
   stable element id. Handles remain stable allocation-ordered addresses.
3. **Parentage is stable identity.** The refusal explains it; reparenting is
   out of scope and stays out.
4. **Propose success is never repriced by notification problems.** The durable
   approval request and the notification are separate facts with separate
   outcomes; neither failure rolls back the proposed revision.
5. **The ledger derives from the one approval-applicability authority.**
   `approvalApplies` (fingerprint carry over ancestors) plus
   `elementApprovalBasis` classify every subject; no receipt recomputes carry
   with private rules.
6. **Rationale lives where the wrong inference happens** — refusals and
   receipts first, help second, the skill third, never the happy path
   (reflection §6.1).
7. **Designed constraints remain.** Staged authoring, human-only acts, stable
   handles, immutable parents, and removal-is-not-deletion are product
   behavior; this slice labels them as such instead of weakening them.

The approved requirements → design → tasks gate remains in force. Before code
implementation, the approved Native SDD spec documents must be amended and
approved for the changed read contract, lint scope, refusal vocabulary,
propose behavior, and ledger reporting (Phase 0 below). Where this document
tightens the parent design (a fifth request outcome, per-pending-gate filing,
a revision-number selector), the parent document is updated in the same change
so the two do not define parallel truths.

## 3. Confirmed current defects

| Surface | Current behavior | Defect |
| --- | --- | --- |
| `spec get` read path | `getSpecElementGET` walks older revisions newest-first and silently rebinds the snapshot (`route-handlers.ts:2842-2861`); the only signal is the response's `revision` field | An agent verifying its own destructive edit reads the removed element as though live (reflection §2.2, twice) |
| `spec get` CLI | `flags: []` in the help registry; `checkFlags` refuses `--revision`; the API already accepts `?revisionId=` that only Spec Studio uses | Intentional archaeology is impossible; accidental archaeology is silent |
| Sections | No handle grammar production (`handles.ts:4-9`), null handle by rule (`review-state.ts:54`), outline hardcodes `returned: 0` (`route-handlers.ts:2046`), search excludes them, CLI rejects element ids pre-network (`read.ts:1657-1667`); the element route matches ids only via a `?? elementId` fallback accident (`review-state.ts:82`) | The most-edited prose has no first-class read; agents export whole bundles to read one section (reflection §2.7) |
| Lint | `9.6.dangling-handle` reads only typed id-based reference fields via `elementReferences`; sections, requirements, and criteria contribute no references at all | Prose handle references silently rot on renumbering; the reflection shipped a wrong reference through clean lint twice (§2.4) |
| Element update | The input schema accepts `parentElementId`; `stagedParentElementId` (`authoring-service.ts:696-711`) and the update branch (`:1786-1793`) drop it; the repo input schema cannot even represent it | A re-parent attempt returns HTTP 200, reports success, and does nothing (reflection §2.6) |
| Propose | `proposeRevision` files no approval request; the receipt's `nextAction` demands a deterministic `request-approval` follow-up — six of six times in the reflection (§2.8) | A guaranteed two-call sequence on every proposal |
| `request-approval` | The notifier call at `review-service.ts:4219` is unguarded outside the transaction | A notifier throw converts a durably committed request into a 5xx for the caller |
| Status/receipts | `cctl spec status` never renders `importCarriedApprovals`; `pendingBlockLines` drops `importCarriedSubjects`; nothing anywhere distinguishes an approval carried from an ancestor from one granted on the current revision | The pending-only view reads as "7 lost", not "7 banked"; the agent mispriced reopening and avoided a sanctioned act (reflection §6.2) |
| `stage_blocked` | Both producer branches (`transitions.ts:254-284`) state the rule and next act, never the reason | The reflection spent a section arguing to weaken a boundary one sentence of rationale would have defended (§6.3) |

## 4. Scope

### 4.1 Included

- Current-only default for `spec get`, a `historical_only` read refusal, and an
  explicit `--revision` selector on `spec get`.
- `cctl spec section get` plus section discovery in the `spec show` outline.
- `9.6.dangling-handle` extended to Markdown prose fields via a masked-scan
  extractor whose false-positive boundary is defined by tests.
- A `parent_immutable` typed refusal on ordinary element updates.
- A server-side propose coordinator that idempotently files gate-scoped
  approval requests after a successful proposal, with typed request outcomes.
- A guarded notifier in `requestApproval` and a delivery outcome on the
  `request-approval` receipt.
- A two-sided approval ledger in the authoring review projection, `spec
  status`, and the propose / withdraw-proposal / Request Changes receipts.
- An optional `rationale` field on the refusal envelope, a registered `why:`
  guidance prefix, and populated rationale for the flagship designed
  constraints.
- Help-registry, offline-schema, and skill/guidance updates, including the
  designed-versus-incidental friction taxonomy and batch-local element-id
  cross-referencing.

### 4.2 Excluded

- Section handles, position-derived or renumbered handles, and prospective
  handle dry runs.
- Reparenting an existing stable element.
- Arbitrary URL/path provenance sources.
- Any change to staged authoring, human-only authority, Q/A lifecycle,
  citations, or the comment domain (slices 1 and 2 own those).
- Prose-handle lint over question/assumption record text: records are
  spec-scoped mutable rows outside the revision snapshot, correctable through
  `spec attention edit`, and lint's input model deliberately excludes their
  text. Revisit only with evidence of real cost.
- Validating slug-qualified references to *other* specs: lint reads one spec's
  snapshot and must not grow cross-spec reads.
- Section content in `spec search`.
- New Spec Studio UI. Strict-schema consumers are updated mechanically; the
  Studio already renders import-carried subjects and needs no new surface for
  this slice.
- Compatibility shims, dual contracts, or old-build fallbacks.

## 5. Current-only element reads

### 5.1 Behavior

`getSpecElementGET` keeps its resolution order — Q/A short-circuit, explicit
revision target, current-snapshot match — and **deletes the implicit
newest-first fallback scan** as an answer path. The scan survives only to name
the refusal:

- handle resolves in the target snapshot → unchanged success;
- handle absent from the current snapshot but present in an older revision,
  and no explicit revision was requested → `historical_only` refusal;
- handle absent everywhere → existing `Spec element not found`.

Q/A handles are spec-scoped records and never enter the revision scan; their
resolution is unchanged. `observedRevision` reference-state production and the
Spec Studio queries that already pass `?revisionId=` are unchanged.

### 5.2 The `historical_only` refusal

The read path follows the existing route-level read-code precedent
(`invalid_handle`), not `refusalCodeSchema`: domain refusal codes are the
action vocabulary rendered through the 409 refusal envelope, while read misses
are 404 `notFound` envelopes with a `code` and structured details. The CLI
already forwards `code`, `details`, and `instruction` through
`structuredErrorFields`.

Response shape (HTTP 404):

```ts
{
  error: "Spec element exists only in a historical revision",
  code: "historical_only",
  details: {
    handle: string,
    elementId: string,
    lastRevisionId: string,
    lastRevisionNumber: number,
    currentRevisionId: string,
    currentRevisionNumber: number,
  },
  instruction:
    "Read the historical element with `cctl spec get <slug>/<handle> " +
    "--revision <lastRevisionNumber>`. The current revision does not " +
    "contain this handle.",
}
```

The CLI renders the error, the last-containing revision, and the exact
copy-pasteable historical command. Text and JSON carry the same facts.

### 5.3 The `--revision` selector

`spec get` gains one value flag, declared in the help registry:

- `--revision <n|id>` — an all-digits value (`/^[1-9][0-9]*$/`) is a revision
  number; anything else is a revision id. The route gains `?revisionNumber=`
  beside the existing `?revisionId=`; an unknown value in either form returns
  the existing 404 `Spec revision not found`.

Revision numbers are how every receipt and status line names revisions, so the
refusal's recovery command uses the number. An explicit historical read needs
no extra marker: the response's `revision` block already names what was read,
and with the fallback gone, historical content is only ever explicitly
requested.

`cctl spec section get` (§6) accepts the same selector with the same
semantics.

### 5.4 What deliberately does not change

- The write path's `historical_element_id` refusal and its three reasons.
- `edit-context`, which already matches only the current draft.
- Reference chips: `?observedRevision=` still yields
  `{observed, latest}` payload-hash comparison.
- The `/elements/<id>` accidental id-match for handle-less elements. It becomes
  redundant for agents once `spec section get` exists but is Studio-reachable
  today; removing it is cleanup for a later change, not a contract this slice
  depends on.

## 6. Narrow section reads

### 6.1 Command

```text
cctl spec section get <slug> --id <element-id> [--revision <n|id>]
```

Returns exactly one section with:

```ts
{
  specId, slug,
  kind: "section",
  handle: null,           // sections are addressed by element id, by design
  elementId, role, title, body,
  elementVersion, position,
  revision: { id, number, state, authoringStage },
}
```

`handle: null` is literal in the schema so no consumer invents a section
handle. `elementVersion` makes the read-modify-write loop first-class: the
reflection guessed `1` and relied on a stale-write refusal to learn the truth
(§2.7).

Refusals:

- unknown element id → `not_found`;
- the id resolves to a non-section element → typed error naming the element's
  actual kind and handle with the instruction to use
  `cctl spec get <slug>/<handle>`;
- the id exists only historically and no `--revision` was given →
  `historical_only` (§5.2 shape, with `handle` null and the recovery naming
  `spec section get … --revision <n>`).

### 6.2 Route and wiring

New one-line route `src/app/api/specs/[name]/[slug]/sections/[element]/route.ts`
re-exporting `specSectionGET` from `route-handlers.ts`. A dedicated handler and
`specSectionViewSchema` keep the contract clean rather than overloading the
element view (whose approvals/evidence/reference blocks are meaningless for
sections and whose `handle` field would have to echo an element id).

The CLI verb is a `spec section` subgroup exactly on the `spec attention`
precedent: nested `dispatchGroup`, colocated help entries, a named envelope in
`read-envelopes.ts` plus the offline `spec schema read-envelopes` document,
project-route-wiring and session-env-inventory classification, and regenerated
cc-cli SKILL.md blocks. Text output follows the `spec get` convention: the
narrowest read is depth-complete — every field JSON carries, flattened to
`path: value` lines.

### 6.3 Discovery: sections in the outline

`spec section get` is unusable without a source of element ids, and today the
outline hardcodes `sections: {returned: 0, truncated: total > 0}`. The `spec
show` outline gains a bounded sections list:

```ts
sections: { elementId, role, title, position, elementVersion }[]
```

bounded by the existing root limit, with the disclosure's `next` naming
`cctl spec section get <slug> --id <element-id>`. This is an addition beyond
the parent design's letter, justified by discovery: without it the verb
requires `spec export` archaeology to use, which recreates the defect it
fixes.

### 6.4 Guidance at the wrong door

`explainInvalidElementHandle` already tells a caller that an element id "looks
like an element id, not an element handle." That explanation now also names
`cctl spec section get <slug> --id <element-id>` as the read for handle-less
elements. The hint-token arch test verifies the named command resolves.

## 7. Prose reference lint

### 7.1 Rule scope

`9.6.dangling-handle` keeps its id-based typed-reference findings and gains
prose findings over every Markdown-rendered string field in the current draft
snapshot:

| Kind | Scanned fields |
| --- | --- |
| section | `title`, `body` |
| requirement | `statement` |
| criterion | `text`, `validationStrategy.note` |
| decision | `title`, `chosenApproach`, `reason`, `rejectedAlternatives[].reason` |
| task | `title`, `instructions` |

`rejectedAlternatives[].label` is plain text, not Markdown, and is excluded.
The field map is an exhaustive per-kind switch (the `typedReferenceGroups`
pattern) so a new element kind is a compile error, not a silent scan gap.

### 7.2 Extractor

Add `src/lib/specs/prose-references.ts`: a masking scanner, not a Markdown
parser. It masks fenced code blocks (``` and ~~~ fences at up to three spaces
of indentation), inline code spans (backtick runs), autolinks, raw URLs, and
Markdown link destinations, then matches candidate handle tokens in the
remaining text at lexical boundaries using the canonical grammar from
`handles.ts` (`isWellFormedElementHandle` and the criterion-before-requirement
precedence).

Constraints that shape this choice:

- `markdown-boundary.test.ts` bans `react-markdown`/`remark-gfm`/renderer
  imports and hand-rolled markdown-lite *parsers* inside `src/lib/specs/**`.
  The scanner renders nothing and parses no inline structure; it only masks
  regions where token matching must not happen. Module and identifier naming
  stays clear of the banned identifier list.
- A direct mdast/micromark dependency was considered and rejected: the scan
  needs "not inside code or a URL", not an AST, and the boundary test exists
  precisely to keep Markdown machinery out of the domain layer.
- Per the parent design, **tests define the false-positive boundary**; the
  regexes are an implementation detail reviewed through the case matrix in
  §7.4, not a contract.

Recognized token forms: bare `R1`, `R1.2`, `D2`, `T3`, `Q4`, `A5` and
slug-qualified `some-slug/R1` at lexical boundaries. A qualified token whose
slug equals the current spec's slug validates like a bare token; a foreign
slug is recognized and skipped (validating it would require cross-spec reads
that lint's input model forbids — §4.2).

### 7.3 Validation semantics

For each candidate token in a scanned field of the current draft snapshot:

- resolves to a current element handle (or, for `Qn`/`An`, an existing
  question/assumption number in the spec's records, any lifecycle state) →
  pass;
- matches the handle of a known element absent from the draft → finding:
  `<source> prose references removed <kind> <handle> in <field>.`;
- matches no known handle or record → finding:
  `<source> prose references unknown handle <token> in <field>.`

Both findings keep the rule's existing `blocks_propose` severity. `Qn`/`An`
references to withdrawn or superseded records pass: those records still exist,
their state is visible in the attention register, and existence — not
lifecycle — is what a reference asserts.

Findings deduplicate per `(element, field, token)`. The source
`elementHandle` uses the existing convention: the element's handle, or its
element id for sections. Messages name the source, the offending token, and
the field, matching the current rule's voice.

### 7.4 False-positive boundary (the test-defined contract)

Must flag:

- `R3` / `R1.2` / `D4` / `T2` / `Q1` / `A4` as standalone prose tokens whose
  target is removed or unknown, including sentence-final position (`… per
  R3.`), parenthesized, comma-separated lists, and same-slug qualified forms;
- the reflection's exact case: prose citing `R12.2` after renumbering.

Must not flag:

- anything inside fenced code blocks, inline code spans, autolinks, raw URLs,
  or link destinations (link *text* is scanned);
- tokens embedded in larger words or identifiers: `PR1`, `R10x`, `T3sting`,
  `FOO-R3`, `us-east-1/R2`-style path fragments where the boundary characters
  are word-like;
- version-ish strings: `v1.2`, `R1.2.3` (no partial match of `R1.2`);
- handle-shaped words with leading zeros or zero (`R0`, `R01`) — the grammar
  already rejects them;
- indented (four-space) code blocks are **not** masked: block-context
  tracking inside lists is where masking scanners become parsers. Spec prose
  uses fenced code; the fence and inline-code masks are the documented escape
  hatch for mentioning a literal token without asserting a reference. A test
  pins this boundary as intentional.

### 7.5 Consequences

- A draft whose prose already dangles will now refuse to propose. That is the
  intended behavior change — the remedy is fixing the reference (or fencing a
  deliberate literal), and lint reports it before the transition per the
  existing pre-propose contract.
- Import parity: `spec import` runs the same lint, so a bundle with dangling
  prose references now fails import. Intended: the bundle claims to be a
  precise contract.
- Frozen revisions are never re-linted; no historical revision changes state.

## 8. Immutable parent refusal

Add `parent_immutable` to `refusalCodeSchema` and refuse an ordinary update
whose `parentElementId` differs from the stored parent, in both the single
upsert and the batch item path, before any write:

```ts
{
  code: "parent_immutable",
  unmetConditions: [
    "<handle>'s parent is part of its stable identity across revisions " +
    "and cannot change after creation.",
  ],
  details: {
    elementId, handle,
    currentParentElementId, requestedParentElementId,
  },
  rationale:
    "containment is identity: a moved element would retroactively change " +
    "what every frozen revision contained",
  instruction:
    "Create a replacement element under the desired parent and remove " +
    "<handle> from the draft with `cctl spec remove`.",
}
```

Admission rule: omitting the field, or echoing the stored parent (the common
read-modify-write echo), stays legal; naming any different parent — including
null against a non-null parent — refuses. The create branch is unchanged.
`stagedParentElementId` and the repo's structurally parent-less update schema
remain as defense in depth; the refusal simply stops lying about them. The
`historical_element_id` reintroduction reason `parent_changed` is unchanged.

The offline `spec schema element-batch` document and the authoring skill state
parent immutability explicitly, closing the reflection's "the schema presents
it as an ordinary writable field" gap (§2.6).

## 9. Propose coordinator and approval requests

### 9.1 Coordinator behavior

`proposeRevision` keeps its transaction exactly as is. After commit, a
server-side coordinator step in the same request:

1. reads the post-transition projection already computed by propose;
2. determines the gates the proposal left pending — normally exactly the
   revision's concluding authoring gate from the authoring sequence; a
   cumulative propose whose earlier consulted stages also have pending
   subjects yields one gate-scoped ask per pending gate;
3. calls the existing `requestApproval` service per pending gate with no
   subject, producing the gate-scoped ask whose identity
   (`specId, revisionId, gate, scope: "gate"`) the event store already
   dedupes;
4. reuses the stable `attentionId` when the ask already exists; and
5. reports a typed outcome per gate without ever failing the proposal.

The parent design said "once with no subject"; per-pending-gate filing is a
refinement forced by the cumulative consulted-gate model
(`consultedAuthoringGates` includes every earlier stage whose content differs
from the approved baseline). The parent document is updated accordingly.

Because propose has just frozen the revision, the request validator's
draft-refusal branch is unreachable by construction; `already_satisfied` maps
to `not-needed` (fast-path and absorbed-sign-off proposals file nothing).

### 9.2 Request outcomes

```ts
type ApprovalRequestOutcome =
  | { gate; outcome: "filed"; attentionId: string }
  | { gate; outcome: "already-filed"; attentionId: string }
  | { gate; outcome: "not-needed"; attentionId: null }
  | { gate; outcome: "delivery-uncertain"; attentionId: string }
  | { gate; outcome: "not-filed"; attentionId: null };
```

- `filed` — a new durable request for this gate identity.
- `already-filed` — the gate-scoped identity `(specId, revisionId, gate,
  scope: "gate")` is already open at filing time: the receipt carries that
  open request's stable attention id and no second durable row is created.
  Request Changes is **not** such a case. It ends the reviewed revision as
  withdrawn, retires that revision's authoring requests (a retired row is
  excluded from identity lookup forever), and opens a new based-on draft — so
  re-proposing that draft addresses a strictly new revision id and reports
  `filed` with a new attention id. Because the request validator refuses an
  authoring ask on a draft, and a proposed revision cannot be re-proposed,
  `already-filed` is unreachable from a fresh propose by construction; it is
  the honest mapping the coordinator owes when the request service reports an
  existing open ask, and it is reachable through the explicit
  `request-approval` repair verb.
- `not-needed` — as in the parent design (fast-path collapse, absorbed
  sign-off, and `already_satisfied`).
- `delivery-uncertain` — the durable request committed but the notifier threw;
  the Needs You row may be missing. Recovery is `cctl spec request-approval`,
  whose ensure path re-fires the notifier against the stable attention id.
- `not-filed` — the filing itself failed before the durable commit
  (unexpected refusal or error). The proposal remains successful; the receipt
  carries the failure category and the explicit `request-approval` recovery.
  This fifth outcome is an addition to the parent design's four: folding a
  filing failure into `delivery-uncertain` would falsely claim a durable
  request exists.

### 9.3 Guarded notifier (fixes an existing defect)

Inside `requestApproval`, the post-commit notifier call is wrapped: a notifier
throw logs a stable warn event and yields `deliveryOutcome:
"delivery-uncertain"` on the receipt instead of propagating into a 5xx for an
act that durably succeeded. `approvalRequestsClosed` gets the same guard. The
existing two-layer idempotency (event identity, notification `dedupeKey`) is
unchanged and is what makes `request-approval` the safe repair verb.

The `request-approval` receipt gains the same typed `deliveryOutcome` field so
its callers see `delivered` versus `delivery-uncertain` explicitly.

### 9.4 Receipt and wire changes

`specProposeResultViewSchema` gains `approvalRequests:
ApprovalRequestOutcome[]` and the ledger (§10). The CLI propose receipt
renders one line per gate:

```text
approval requests: requirements filed (attention 7f3a…)
```

and its `next:` guidance stops naming `request-approval` when every pending
gate reports `filed`/`already-filed`: the truthful next act is a human
approving in Spec Studio, so `actsNext` is `human`. `request-approval` remains
registered as the explicit retry/repair verb, and its help text is reframed
around recovery (`delivery-uncertain`, retired asks) rather than the routine
second step it no longer is.

## 10. Two-sided approval ledger

### 10.1 Classification

One derivation, in `authoring-review-projection.ts` beside the existing
pending/import-carried split. `approvalHeld` widens to return the matched
approval row so the projection can classify, per subject, from the same
authority every gate decision already uses:

| Class | Meaning | Source of truth |
| --- | --- | --- |
| `carried` | Valid human approval from an ancestor revision whose subject fingerprint still matches | `approvalApplies` with `approval.revisionId ≠ projected revision` |
| `current-revision` | Valid human approval granted on the projected revision | `approvalApplies` with matching revision id |
| `import-settled` | Subject covered by the import baseline fingerprint | `elementApprovalBasis` = `import_carry_forward`; emphatically not an approval |
| `combined-act` | Subject under a collapsed (combined-dial) gate on a revision whose sign-off/absorbed approval records the combined act | policy collapse + recorded sign-off |
| `pending` | None of the above | existing pending projection |

Gates that are not per-subject governed are named as such rather than forced
into subject counts:

- a collapsed gate **before** its sign-off reports its subjects as governed by
  the combined sign-off with the sign-off outstanding — never a manufactured
  zero-count ledger and never "not applicable";
- a notify/off-dial gate reports its policy admission at gate level
  (`admitted by notify policy — no per-subject approvals exist`), which the
  gate lines already know how to say.

### 10.2 Rendering

`spec status` (which today renders import-carried nowhere) gains:

```text
approval subjects: 12 satisfied (8 carried, 3 current-revision, 1 import-settled) · 6 pending
carry rule: unchanged subject content under the same applicable gate
```

and the collapsed fast path after sign-off:

```text
approval subjects: 18 satisfied (18 combined-act) · 0 pending
sign-off: satisfied (combined act)
```

The `carry rule:` line is the mechanism sentence, printed where the wrong
inference happens (reflection §6.2: a pending-only list reads as "7 lost", not
"7 banked"). Rendering lives in the shared `projection-text.ts` helpers so
status and receipts cannot diverge, and `pendingBlockLines` stops dropping
`importCarriedSubjects`. JSON carries the ledger as named fields beside the
existing `pendingApprovals`/`importCarriedApprovals`, which keep their exact
current meaning.

### 10.3 Receipts

- **Propose** — ledger plus `approvalRequests` (§9.4). A successful propose now
  reads as a progress report: what carried, what a human still owes, what was
  auto-filed.
- **Withdraw-proposal** — the receipt gains the ledger computed against the
  reopened draft plus the fear-moment sentence: `approvals on unchanged
  subjects carry into the reopened draft; only edited subjects need
  re-approval.` The reflection identifies this receipt as where the mispricing
  happened (§6.2 fix 3).
- **Request Changes** — same ledger and sentence on its response and in the
  `reviewFeedback` message delivered to the proposing conversation, so the
  agent that must act on the feedback also sees the carry truth.

## 11. Refusal rationale

### 11.1 Mechanism

`refusalSchema` gains an optional `rationale: string`. The CLI renders it as a
`why:` line between the unmet conditions and the instruction, and `why:` joins
the enumerated guidance prefixes (`guidance-prefixes.ts` and its arch test).
Rationale is server-authored, one sentence, asserting the value rather than
apologizing — *"this is deliberate: X"* recruits; *"unfortunately"* invites a
workaround (reflection §6.3).

### 11.2 Populated in this slice

| Refusal | Rationale line |
| --- | --- |
| `stage_blocked` (later-stage element) | `requirements settle before design so solution choices cannot shape the contract around themselves` |
| `stage_blocked` (plan element in evergreen revision) | `delivery plans bind a settled design; authoring one earlier would shape the design around its own execution` |
| `human_act_required` | `approval, sign-off, question answers, assumption dispositions, and thread resolution are human judgments the agent surface must not perform` |
| withdraw-after-engagement | the existing principle sentence — `an attempt a human has acted on ends on their terms, not by the author erasing it` — moves from prose into the typed field |
| `parent_immutable` | as specified in §8 |

Other refusals adopt the field opportunistically in later work; this slice
establishes the mechanism and the flagship set. Rationale is never printed on
success paths.

## 12. CLI and guidance surface

### 12.1 Registry and contract obligations

Every new or changed verb follows the standing checklist: `CommandHelpEntry`
with flags/examples/related edges (`spec.help.ts`), dispatch wiring
(`index.ts` — `spec section` as a nested group on the `spec attention`
precedent), named `--json` envelopes (`read-envelopes.ts` and its
`SPEC_READ_ENVELOPE_FIELDS`), the offline `spec schema read-envelopes`
document, session-env classification, route wiring for the new section GET,
and regeneration of the cc-cli SKILL.md generated blocks. The registry-derived
contract sweeps (help-registry, json-envelope, hint-tokens, skill-reference
drift) cover the new surface automatically; the spec-specific help prose tests
gain cases for the new nodes' disclosure claims.

### 12.2 Offline schema documents

- `read-envelopes`: the section envelope, the `--revision` selector semantics,
  and the `historical_only` shape.
- `element-batch`: parent immutability after creation, and **batch-local
  element ids** — author-minted element ids let one batch create an element
  and reference it from a sibling's typed reference fields in the same write,
  which dissolves the "cross-reference cannot be written in its creating
  batch" complaint without touching handle allocation (parent design §2).

### 12.3 Skill and guidance text

`native-sdd-authoring/SKILL.md` (and its packaged copies via the existing
generation path) gains:

- the current-only read contract, `--revision`, and `spec section get` in the
  read-navigation walk;
- the `spec attention` verbs for obsolete records — absent since slice 2
  shipped, a known gap;
- propose behavior: approval requests are auto-filed; `request-approval` is
  recovery, not routine;
- the carry mechanism in one line (reflection §6.2 fix 4);
- batch-local element-id cross-referencing and the fenced-literal escape hatch
  for prose lint;
- the designed-versus-incidental friction taxonomy (reflection §6.4): staged
  authoring, human-only acts, withdraw-after-engagement, frozen revisions,
  stable handles, immutable parents, and validation-strategy strictness are
  the product — lean in; read paths, messages, and missing verbs are defects —
  report them. The heuristic: friction protecting a human judgment or an audit
  property is designed; absorb it.

`.claude/commands/spec.md` mirrors the read-contract and propose changes. The
guidance never tells an agent to park design work anywhere during
requirements, to reject an assumption, or to treat Q/A as design notes.

## 13. Data and compatibility impact

No database change of any kind: no table, column, trigger, backfill, or
`KNOWN_SCHEMA_VERSION` bump. The durable `approval-requested` /
`approval-request-retired` event families and their identity rules are reused
exactly as they exist.

This is a coordinated application/API cutover in the repository's usual
style:

- strict view schemas gain required fields (`approvalLedger`,
  `approvalRequests`, outline `sections`, the section view) and all producers
  and consumers update in the same change;
- `refusalCodeSchema` gains `parent_immutable`; the refusal envelope gains
  optional `rationale`; the read path gains the route-level `historical_only`
  code;
- removing the silent historical fallback is a behavior cutover with no
  compatibility read path: an agent or test relying on the fallback was
  relying on the defect;
- no shim, no dual contract, no old-build fallback.

Formal Native SDD spec amendment precedes implementation (§2); the changed
read contract, lint scope, propose behavior, and receipts are exactly the
kind of approved-document drift the staged process exists to price.

## 14. Red-green-refactor plan

Each loop runs the registered test command against one explicit test file
(`cctl validate run test --wait -- <file>`); changed-scope, typecheck, seams,
and build run at checkpoints.

### Phase 0 — Formal Native SDD amendment

Amend `.kiro/specs/native-sdd/` requirements, then design, then tasks for the
behavior in this document, obtaining approval at each stage.

### Phase 1 — Current-only reads and selector

1. Failing route tests: fallback removed, `historical_only` shape and details,
   `--revision` by number and id, unknown-revision 404, Q/A short-circuit and
   `observedRevision` untouched.
2. Failing CLI tests in `read.contract.test.ts`: flag parsing, refusal
   rendering with the copy-pasteable recovery, historical read header.
3. Implement route + CLI minimally; refactor.

### Phase 2 — Section reads

1. Failing route tests: section view shape (`handle: null`), non-section id
   redirect-to-`spec get` error, `not_found`, historical behavior.
2. Failing outline tests: bounded sections list and its disclosure `next`.
3. Failing CLI tests: `spec section get` envelope/text,
   `explainInvalidElementHandle` naming the section command.
4. Implement handler, route, envelope, help entries, dispatch; regenerate
   skill blocks; refactor.

### Phase 3 — Prose lint

1. `prose-references.test.ts` first: the full §7.4 positive/negative matrix
   defines the extractor before lint sees it.
2. Failing `lint.test.ts` cases: per-kind field coverage, removed versus
   unknown messages, Q/A existence semantics, dedupe, section sources named by
   element id, propose blocked.
3. Implement extractor and rule extension; verify import parity via the
   existing import lint tests.

### Phase 4 — Parent refusal

1. Failing authoring-service tests: differing parent refused (single and
   batch, null-vs-non-null), echoing parent legal, create unchanged, refusal
   shape with details and rationale.
2. Implement admission check + schema code; update `element-batch` offline
   doc.

### Phase 5 — Propose coordinator and guarded notifier

1. Failing review-service tests: notifier throw yields `delivery-uncertain`
   without failing the act; `approvalRequestsClosed` guarded; receipt
   `deliveryOutcome`.
2. Failing propose tests: outcomes per gate (filed / already-filed on an
   already-open gate identity / not-needed on fast path and absorbed sign-off
   / delivery-uncertain / not-filed); Request Changes proven end to end
   through the real request service — the withdrawn revision's asks are
   retired and re-proposing the new draft files a fresh ask under the new
   revision id, leaving exactly one open gate-scoped authoring request;
   proposal success never converted to failure; receipt and `actsNext`
   changes.
3. Implement the post-commit coordinator with an injected approval-request
   port via the service factory (composition, no internal mocks).

### Phase 6 — Approval ledger

1. Failing projection tests: five-way classification from the single
   authority, carried-versus-current by revision id, collapsed gate before and
   after sign-off, policy-admitted gates at gate level, import-settled never
   labelled an approval.
2. Failing rendering tests: status text lines, `carry rule:` line, receipts
   for propose/withdraw/Request Changes, `pendingBlockLines` carrying
   import-carried subjects, JSON parity.
3. Implement projection widening and shared renderers.

### Phase 7 — Rationale and guidance

1. Failing tests: `rationale` field round-trip, `why:` prefix registration
   and rendering order, populated flagship refusals.
2. Skill/guidance edits, help prose tests, skill-block regeneration, and the
   packaging test that walks the loop from injected skill text alone.

### Checkpoints

Changed-scope test, typecheck, seams, lint, and build; then a live pass:
author a scratch spec, renumber an element to create a prose dangle, verify
lint blocks and names it; read a section narrowly; attempt a re-parent and
read the refusal; propose and verify the auto-filed Needs You row, the
ledger, and the withdraw-and-reopen carry sentence; kill the notifier path to
observe `delivery-uncertain` and recover with `request-approval`.

## 15. Acceptance matrix

| Behavior | Required evidence |
| --- | --- |
| Ordinary read never answers historically | Route + CLI tests; fallback code deleted |
| Historical-only handle names last revision and exact recovery | `historical_only` shape test |
| Explicit archaeology works by number and id | Selector tests both forms |
| One section readable narrowly, `handle: null`, no invented grammar | Section view + CLI tests |
| Sections discoverable | Outline sections + disclosure test |
| Prose dangles block propose; boundary cases never flag | §7.4 matrix in extractor + lint tests |
| Fenced/inline literals are a documented escape | Boundary test + skill text |
| Re-parent attempt refused, not ignored | Single + batch admission tests |
| Proposal auto-files idempotent gate asks | Propose outcome tests incl. replay |
| Notification failure degrades, never fails the act | Guarded-notifier tests on both verbs |
| `not-filed` never claims a durable request | Coordinator failure-arm test |
| Ledger distinguishes carried / current-revision / import-settled / combined-act / pending | Projection classification tests |
| Collapsed gate never yields a zero-count or not-applicable ledger | Pre/post sign-off collapsed tests |
| Reopen receipts state the carry rule | Withdraw + Request Changes receipt tests |
| Flagship refusals carry `why:` | Rationale rendering tests |
| Skill teaches taxonomy, attention verbs, new reads, propose change | Help prose + packaging tests |
| No DB change | No migration in the diff; schema floor untouched |

## 16. Risks and containment

| Risk | Containment |
| --- | --- |
| Prose lint flags legitimate prose and bricks live drafts | Test-defined boundary matrix; masked-code escape hatch; finding names exact token/field so the fix is mechanical |
| A live spec's existing prose dangles block its next propose | Intended and disclosed; lint runs pre-propose with the exact remedy; no frozen state changes |
| Something depended on the silent historical fallback | Recon found only Studio explicit-revision reads and reference chips, both on explicit params; route tests pin the new refusal |
| Multi-gate propose files multiple Needs You rows | Event identity + notification dedupe make each ask single; receipts name each |
| Coordinator failure modes misreported | Five-outcome enum keeps "durable" and "delivered" separate; `not-filed` is the honest arm |
| Ledger drifts from gate decisions | Single derivation beside `recordSubject`, shared text renderers, no receipt-local recomputation |
| Strict-schema ripple breaks consumers | Atomic cutover; registry/envelope contract sweeps catch stragglers |
| `why:` prefix proliferates into noise | Registered prefix + arch test; rationale only on designed-constraint refusals, never on success paths |

## 17. Completion boundary

This slice is complete when an agent can run the reflection's session without
any of its §2 traps: every read answers from the revision it claims, sections
are one command away, a renumbering cannot silently orphan prose references, a
re-parent attempt teaches instead of lying, a proposal is one call that ends
with the human notified, and every receipt along the reopen loop prices
approvals truthfully. With slices 1 and 2 already landed, this closes the
implementation scope of command-center#87.
