# Implementation Plan
- [x] 1. Foundation: spec domain schemas and database floor
- [x] 1.1 Define the spec domain schemas
  - Author the domain schema module covering all persisted row shapes for the 19 spec tables, the kind-discriminated element payload union (section, requirement, criterion, decision, task), gate policy (preset plus sparse per-gate overrides), evidence kinds with the evaluated-state shape, actor provenance, refusal codes with the shared refusal shape, and the durable event-type catalog
  - Element payload rules: criteria carry declared validation strategies and nest under requirements; decisions carry chosen approach, rejected alternatives, and reason; tasks carry traced requirements, covered criteria (many-to-many), and task dependencies; requirements carry statement and priority/risk
  - Derive all types with z.infer; reads validate with safeParse and quarantine unparseable rows per house pattern
  - Done when: unit tests parse and reject fixture payloads for every element kind and the policy shape, and `bun run typecheck` passes with no hand-written duplicate types
  - _Requirements: 2.3, 2.7, 2.9, 2.10, 2.11, 11.1, 13.3_

- [x] 1.2 Add the spec tables to the database floor
  - All 19 additive `CREATE TABLE IF NOT EXISTS` entries plus indexes in the schema floor: specs, aliases, counters, elements, revisions, element versions, approvals, gate admissions, questions, assumptions, comments, evidence, proof verdicts, waivers, criterion dispositions, task claims, executions, links, events
  - Uniqueness constraints: per-project slug on specs, per-spec revision numbers, composite keys for element versions, counters, and dispositions; no KNOWN_SCHEMA_VERSION bump so older branch builds ignore the new tables
  - Done when: a fresh in-memory fixture and an existing DB both open with all tables present, and repeated/concurrent opens (idempotent DDL) do not error
  - _Requirements: 2.1, 2.14_

- [x] 2. Pure spec logic modules
- [x] 2.1 (P) Handle grammar and deep-link identifiers
  - Parse and format the single handle vocabulary: spec slugs, slug-qualified element handles (R3, R3.2, D2, T7, Q2, A1), and bare handles accepted where surrounding context supplies the slug
  - Provide deep-link element identifiers shared by Studio URLs, chips, CLI output, workflow briefs, and evidence records
  - Done when: round-trip parse/format tests pass for every handle kind and bare-handle resolution resolves against a supplied context slug
  - _Requirements: 1.2, 1.3, 1.4_
  - _Boundary: HandleGrammar_

- [x] 2.2 (P) Policy engine
  - Resolve the five gate dials from preset plus sparse overrides: contract-bearing (all Gate), exploratory (Notify with delivery Gate plus outright claim/merge refusal), fast-path (combined propose-time approval marker, execution start Notify, delivery Gate)
  - An override changes one dial without leaving the preset; the delivery dial can lower to Notify but never Off
  - Done when: the full preset-by-gate matrix and override behavior are unit-tested, including the fast-path combined-approval marker and the delivery-floor rule
  - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.9_
  - _Boundary: PolicyEngine_

- [x] 2.3 (P) Phase and status projections
  - Derive spec phase by explicit precedence (Abandoned → Executing → In review → Draft → Delivered → Approved) returning the composite {primary, authoringFacet} shape; phase is never stored or settable
  - Derive delivery display state: the all-waived flag and the proven/total roll-up; requirement status from approval validity, coverage, and proof state; task work status from execution events and claims only, never from criterion dispositions
  - Done when: unit tests cover the 3.1–3.11 precedence cases including Executing-with-review facet, amendment against approved/delivered returning authoring primaries, and the all-waived flag
  - _Requirements: 2.12, 2.13, 3.1, 3.2, 3.6, 3.7, 3.8, 3.11_
  - _Boundary: PhaseProjection_

- [x] 2.4 (P) Revision diff and element classification
  - Classify every element between a base and a draft as unchanged, modified, or removed; editing a nested criterion marks its requirement modified; any task add/remove/re-scope marks the plan stale; classification scope is direct change only
  - Produce the semantic change list with kind-aware summaries for review consumption
  - Done when: unit tests pin classification outcomes for nested-criterion edits, task re-scopes, unchanged carry-forward, and the change-list output shape
  - _Requirements: 8.4, 10.5, 10.6, 10.7, 10.8_
  - _Boundary: RevisionDiff_

- [x] 2.5 (P) Deterministic lint engine
  - The authoritative R9 catalog as a pure function over structured spec state: blocking findings (empty spec, uncovered criterion, untraced task, dependency cycle or removed-task dependency, dangling handle, claim without evidence, rejected-cited assumption) and advisory findings (approval freshness, dependency change, open questions at propose, materialized task removed/re-scoped)
  - Findings carry rule id, severity class (blocks propose / blocks claim / blocks sign-off / advisory), element handle, and message; deterministic only, no agent judgment
  - Done when: each rule 9.2–9.9 has a fixture-graph unit test producing exactly the expected findings, and one output shape feeds both panel and refusal consumers
  - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9_
  - _Boundary: LintEngine_

- [x] 2.6 (P) Execution scope validation
  - Validate a proposed (task, criterion) scope selection: dependency closure over selected tasks, every selected criterion covered by a selected task, every excluded criterion carrying an explicit disposition, and rejection of partial selections the plan does not define as valid smaller units
  - Done when: unit tests accept a dependency-closed partial scope and reject each of the four defect classes with named defects
  - _Requirements: 16.4, 16.5, 16.6, 16.7_
  - _Boundary: ScopeValidation_

- [x] 2.7 (P) Proof freshness rules
  - Fixed per-kind validity rules independent of autonomy dials: commit/diff evidence counts only as ancestors of the merge candidate; pure rebase with identical relevant tree keeps proof valid; deterministic-validator credit against the pre-merge candidate; screenshots/human sign-offs record their captured surface and stale on surface change; abandoned-run evidence stays immutable fact needing established applicability
  - Pure core with injected git probes (ancestry, relevant-tree hash)
  - Done when: unit tests per evidence kind pin valid/stale outcomes for rules 13.8–13.13 using fake git probes
  - _Requirements: 13.8, 13.9, 13.10, 13.11, 13.12, 13.13_
  - _Boundary: FreshnessRules_

- [x] 2.8 (P) Measures engine
  - The four §6.1 measures as pure computations over a seeded durable event log (plus linked workflow events): requirement-caused rework, approval friction (active spans, interventions, re-approval loops, idle excluded), traceability completeness, automatic evidence capture share
  - A measure-definitions version string supports the pilot freeze
  - Done when: unit tests compute all four measures from seeded event fixtures and the version string is exposed
  - _Requirements: 20.1, 20.3, 20.4_
  - _Boundary: MeasuresEngine_

- [x] 3. State-store repositories with durability contracts
- [x] 3.1 (P) Core specs repository with CAS
  - Persist specs, aliases, counters, elements, revisions, and element versions; atomic counter allocation (upsert-returning, numbers never reused); revision snapshot operations (create draft from base, propose freeze) as single transactions; criterion elements nest under their requirement with stable identity separate from content
  - Per-element compare-and-swap on draft rows returning a typed stale conflict carrying current content and version; content writes against non-draft revisions throw at the repo layer; renames write aliases and lookups resolve specs then aliases
  - Done when: the maximal round-trip contract test covers every persisted field, and CAS interleaving tests on a real SQLite fixture show independent-element writes both landing, a stale same-element write refused with current content, and no last-write-wins path
  - _Requirements: 1.1, 1.6, 2.1, 2.2, 2.4, 2.6, 2.8, 7.1, 7.3, 7.4_
  - _Boundary: SpecsRepo_

- [x] 3.2 (P) Review repository
  - Persist approvals (subject kind, element, revision, approver, grant time, validity), gate admissions (gate, basis, actor, referenced approval), comments (threads, anchors, original revision, blocking flag, resolution), questions, and assumptions
  - Done when: the maximal round-trip contract test covers every persisted field including anchor payloads and validity/disposition states
  - _Requirements: 10.1, 12.1, 12.2_
  - _Boundary: SpecReviewRepo_

- [x] 3.3 (P) Delivery repository
  - Persist evidence records (append-only, criterion-keyed, ref/evaluated-state/producer payloads, ingest idempotency key), proof verdicts, waivers, criterion dispositions, task claims, and executions (pinned revision and scope, state, workflow linkage, session)
  - No update path exists for evidence rows
  - Done when: the maximal round-trip contract test covers every persisted field and an attempted evidence-row update fails
  - _Requirements: 13.1, 13.3, 14.1, 16.1_
  - _Boundary: SpecDeliveryRepo_

- [x] 3.4 (P) Links repository
  - Persist provenance-bearing links to tickets, conversations, sessions, workflow executions, and merge jobs with direction, category, optional element scoping, actor, and immutable source snapshots
  - Done when: the maximal round-trip contract test covers every persisted field including snapshot payloads
  - _Requirements: 2.16_
  - _Boundary: SpecLinksRepo_

- [x] 3.5 (P) Events repository
  - Persist the append-only spec event log with autoincrement ordering and a same-transaction append helper services compose
  - Done when: the contract test round-trips event rows and an ordering test proves insertion order is read order
  - _Requirements: 19.1, 20.1_
  - _Boundary: SpecEventsRepo_

- [x] 4. General workflow-definition capabilities (no spec imports)
- [x] 4.1 (P) Approvable definitions and origin links
  - Optional approvalRequired and origin (opaque sourceUri/label) fields on definition and context schemas; old records parse unchanged; nothing workflow-side parses origin values
  - The approval gate in workflow start: a definition requiring approval refuses start until an approval is recorded (atomic first-decision-wins mirroring the context approval-gate precedent)
  - Done when: integration tests show start refused with `definition_approval_required` until approval then proceeding, and definitions without the fields behave exactly as before
  - _Requirements: 17.3, 17.5_
  - _Boundary: workflow-graph definition schemas, workflow-manager_

- [x] 4.2 Provenance-locked definition regions
  - Optional lockedRegions (paths, sourceUri, reason) on definition schemas, enforced at the three seams: definition-edit operations (atomic batch refusal naming the locked path with an amend-at-source instruction), runtime edits, and definition replace while executions seed from it
  - Done when: integration tests refuse a locked-path edit at each of the three seams with `region_locked`, while edits to unlocked execution-only fields still apply
  - _Requirements: 17.4, 17.5_
  - _Boundary: workflow-graph definition-edits, runtime-edits, storage_

- [x] 5. Merge-machine delivery-gate port (ships dark)
- [x] 5.1 (P) Delivery-gate port and machine invocation
  - Declare the DeliveryGateEvaluator port in the merge domain, add the optional executionId to the merge input type, and invoke the port on every entry into publishing keyed to the prepared candidate; CAS-retry re-prepares are re-gated; refusal produces the typed `deliveryGateFailed` terminal state and halt-reason event before the publish CAS, preserving the parked candidate ref
  - Without an executionId the gate passes through and existing merges are unchanged
  - Done when: machine tests cover initial-prepare gating, re-prepare re-gating, refusal parking the candidate, and a no-executionId merge passing through with the existing merge suite green
  - _Requirements: 18.4_
  - _Boundary: merge machine, merge types_

- [x] 5.2 Execution linkage and candidate-validation fact persistence
  - Persist the merge input's executionId on the merge job record; the validating phase emits a spec-agnostic candidate-validation fact (validationRef, validatedSha, validatedTreeHash, commandIdentity, outcome) persisted beside it; land re-entry rebuilds both from the persisted job into the dispatch
  - Done when: the jobs contract test round-trips both new fields and a land-mode dispatch integration test carries them into merge input
  - _Requirements: 13.10, 18.1_
  - _Boundary: jobs repo, merge validation phase, git route-handlers_

- [x] 6. Reference-registry migration at parity
- [x] 6.1 (P) Reference-type registry with existing types migrated
  - The registry entry contract (node name, xml tag, attr schema, build/parse, editor/transcript chips, picker source); migrate the existing conversation, ticket, and message reference types onto it; serializer, ref parser, ref segments, and paste extension dispatch through the registry; the `!` ticket shortcut is retained
  - Done when: serializer/parser round-trip parity tests for all existing reference types pass unchanged against pinned fixtures
  - _Requirements: 5.1_
  - _Boundary: prompt-editor registry, serializer, conversations ref plumbing_

- [x] 6.2 Unified `#` mention extension
  - One Suggestion instance replaces the parallel mention wirings; its items provider parses the query and returns grouped, type-filterable results across registered types
  - Done when: `#` produces one grouped picker for existing types, insertion behavior is unchanged for conversations/tickets/messages, and the superseded extensions are deleted
  - _Requirements: 5.1_
  - _Boundary: prompt-editor mention extension, prompt popup_

- [x] 7. Transition predicates and the event spine
- [x] 7.1 Transition predicates with one refusal shape
  - Pure decision functions over loaded snapshots for propose, element approval, revision sign-off, execution start, task claims, waiver grant, policy change, and delivery-gate evaluation; every refusal carries code, unmet conditions, optional findings, and a next-step instruction
  - The floor encoded unreachable by any policy value: exploratory refuses claims/merges outright; delivery never Off; waivers human-only; every execution pins (revision, scope); every in-scope criterion needs proof or waiver at merge; sign-off preconditions (blocking threads resolved, no rejected-cited assumptions, dial-configured approvals in place)
  - Done when: unit tests prove floor unreachability under every preset/override combination, sign-off precondition refusals, and identical decisions for identical contexts
  - _Requirements: 3.3, 3.4, 6.5, 10.3, 10.4, 11.2, 11.4, 11.5, 11.6, 11.7, 11.8, 11.9, 14.3, 16.2, 16.3, 18.3_
  - _Depends: 2.2, 2.4, 2.5, 2.6_

- [x] 7.2 (P) Durable events paired with typed SSE
  - The six strict spec SSE event schemas join the union (spec-changed, revision-changed, approval-changed, execution-changed, evidence-changed, attention-changed); an events helper appends durable rows in the mutating transaction and publishes SSE after commit
  - Done when: an integration test shows a mutation appending a durable event row and emitting the typed SSE envelope, and the strict schemas accept published payloads without silent drops
  - _Requirements: 19.1_
  - _Depends: 3.5_
  - _Boundary: sse-events union, spec events helper_

- [x] 8. Authoring and review services
- [x] 8.1 Create and draft authoring
  - Create-on-first-save: a durable spec object exists from the first successful draft save, slug-unique, reusing an existing draft rather than duplicating; element-granular draft upserts/removes/reorders carry base versions through repo CAS; incomplete drafts are legal; amendments against approved/delivered specs open a new draft copied from the approved snapshot while existing pins keep pointing at their revisions
  - Draft writes publish change events so concurrent viewers and authors see them without refresh
  - Done when: integration tests show create-then-partial-draft visible via reads, two writers landing independent element writes with events published, and a stale write returning the typed conflict with current content
  - _Requirements: 3.9, 4.1, 4.2, 4.6, 7.1, 7.2, 7.3, 7.4_

- [x] 8.2 Propose transaction
  - One transaction: run blocking lint, freeze content with the canonical content hash, classify elements, carry forward / stale / close approvals by classification (direct change only), record propose-time gate admissions, and absorb the policy-admitted sign-off when every propose-time dial is Notify/Off (sign-off admission, zero approval rows; a sign-off precondition failure leaves the revision Proposed with the refusal surfaced)
  - A refused propose returns exactly the finding list the lint panel shows; proposing a non-draft is refused
  - Done when: integration tests cover clean propose (frozen, hashed, classified), lint-refused propose returning the finding list, all-Notify/Off propose ending Approved with a sign-off admission and zero approval rows, and a Gate dial leaving the revision Proposed
  - _Requirements: 2.5, 3.3, 9.10, 10.2, 10.5, 10.8_

- [x] 8.3 Review actions and sign-off
  - The four actions: Comment (never unfreezes), Request changes (proposed becomes withdrawn with content and hash intact; a new draft opens based on it), Approve item (durable per-element record; re-approval refreshes), Sign off revision (predicate-gated human path whenever any propose-time dial is Gate); withdraw; bulk approval writes identical per-element records; fast-path combined approval records all element approvals plus sign-off plus admission atomically, all or none
  - Done when: integration tests cover request-changes preserving the withdrawn snapshot and opening the based-on draft, sign-off refusals for unresolved blocking threads / rejected-cited assumptions / missing configured approvals, bulk approval writing per-element rows, and the fast-path transaction being all-or-none
  - _Requirements: 3.4, 8.5, 8.7, 10.1, 10.2, 10.3, 10.4, 11.5_

- [x] 8.4 Questions, assumptions, and policy changes
  - Open questions as addressable records (what is unresolved, attachment point, provenance, open → answered); assumptions proposed by agents and disposed by the human (confirmed/rejected/deferred), attached to spec or element; changing the disposition of an assumption cited by an approved revision refuses with amendment-required; policy changes are human-confirmed, prospective-only, never retroactively creating approvals, with no CLI path
  - Done when: integration tests cover the question lifecycle, assumption disposition flows including the amendment-required refusal, and a policy change applying prospectively only
  - _Requirements: 11.10, 12.1, 12.2, 12.3_

- [x] 8.5 (P) Export, verify, and tamper evidence
  - The canonical portable export bundle (markdown plus manifest) rendered as a projection of durable state; verify recomputes content hashes against stored values and reports mismatches; out-of-band modification of approved content is detectable and surfaced
  - Done when: export produces a deterministic bundle for a seeded spec, verify passes on intact state, and verify reports the exact mismatch after a direct DB mutation of approved content
  - _Requirements: 2.5, 2.15, 6.8_
  - _Depends: 8.2_
  - _Boundary: ExportVerify_

- [x] 9. Evidence, execution, and delivery services
- [x] 9.1 Evidence records and proof verdicts
  - Append-only criterion-keyed evidence with server resolvability per kind (git object, workflow event row or merge-job validation fact, content-store object, human actor record); unresolvable references refuse in the same shape as gate violations; every record carries producer, producing execution, target criterion and revision, and evaluated state
  - Proof verdicts distinct from evidence: a verdict cites at least one resolvable fresh record per strategy-required kind; verdict origins fixed (deterministic/agent verdicts only from execution ingestion, human verdicts only from UI routes); validators never demand beyond the approved strategy — inadequacy routes a finding/question to the human; changing a strategy is an amendment
  - Done when: integration tests refuse unresolvable references and under-strategy verdicts, and accept a verdict satisfying the approved strategy
  - _Requirements: 13.1, 13.2, 13.3, 13.4, 13.5, 13.6_

- [x] 9.2 Claims, waivers, and dispositions
  - Evidence-backed task completion claims: refused with no evidence, unresolvable citations, or citations targeting criteria the task does not cover at the pinned revision; refused outright under the exploratory preset; claims carry accepted/reopened status feeding the rework measure
  - Waivers are human-only with a required reason on (criterion, revision), terminal for that revision; agents and Notify/Off policy may request but never grant; a waived criterion changed later marks the waiver stale requiring a new human decision; "not in this delivery" records as deferred, never waived; delivered-elsewhere only when a merged execution delivered the criterion
  - Done when: integration tests cover each claim refusal case, an agent waiver attempt refused as a human act, waiver staleness on later change, and delivered-elsewhere verification
  - _Requirements: 2.12, 6.6, 9.7, 11.4, 11.8, 14.1, 14.2, 14.3, 14.4, 14.5, 14.6_

- [x] 9.3 (P) Execution plan compiler
  - Pure transform from an approved revision plus validated scope onto the workflow definition schema (using the general capability fields from tasks 4.1/4.2): task dependency-chain grouping to contexts, dependencies to edges, criteria seeding context acceptance criteria and validator briefs (including the approved strategy note), narrow per-lane context packs
  - Contract-derived content marked as locked regions with source links back to spec handles; execution-only choices (isolation, grouping, retries, budgets) left editable
  - Done when: unit tests assert the compiled definition validates against the workflow definition schema and locked regions cover exactly the contract-derived paths
  - _Requirements: 17.1, 17.4_
  - _Depends: 4.1, 4.2_
  - _Boundary: Compiler_

- [x] 9.4 Execution evidence ingestion
  - Idempotent pull materializer over workflow events for a linked execution: validation results and lane commit snapshots route to criteria via the compiled origin map, keyed by source event id; best-effort on evidence reads (a GET never blocks on the write queue), authoritative on claims, execution completion, and the delivery gate
  - Done when: an integration test ingests a seeded workflow event log twice and produces a single identical evidence set routed to the right criteria
  - _Requirements: 13.7_
  - _Depends: 9.1, 9.3_
  - _Boundary: EvidenceIngest_

- [x] 9.5 Execution start with pinning and compilation
  - Predicate-checked start: revision Approved, at most one active execution (definition review counts as active, enforced inside the commit transaction), scope valid per the scope predicate; the two-step protocol — compile and write the definition through general workflow services (approval-required per the execution-start dial, origin idempotency key from spec/revision/scope, locked regions) then one SQLite transaction committing execution, dispositions, links, and events as the authoritative commit point
  - A crash between steps leaves an inert orphan definition; a retried start finds it by origin key and reuses or replaces it; the pinned (revision, scope) has no mutation path after start; start is initiated by agent or human while the dial governs definition approval
  - Done when: integration tests cover each start refusal (unapproved revision, second active, each scope defect), the crash-between-steps orphan reused on retry, and pin immutability
  - _Requirements: 11.6, 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.8, 17.2, 17.3_
  - _Depends: 4.1, 7.1, 9.3_

- [x] 9.6 Execution lifecycle, abandonment, and scope amendments
  - Idempotent markRunning on workflow start; idempotent markDelivered keyed by (execution, merge hash) on publish success updating proven-and-merged dispositions; read-path reconciliation advances stale execution state when callbacks were lost; Delivered is entered only after merge success; while Running the execution retains existing graph-workflow lifecycle behaviors
  - Abandon (execution or spec) requires a reason and is terminal; discovered work becomes a proposed scope amendment on the spec queued for a future execution — never a silent expansion — with abandon-and-restart as the blocking-discovery path
  - Done when: integration tests cover callback replay safety, reconciliation advancing a stale state, abandon-with-reason, and an amendment draft capturing discovered work while the running pin stays unchanged
  - _Requirements: 3.5, 3.10, 16.9, 18.6_

- [x] 9.7 (P) Delivery-gate adapter
  - The merge-domain port implemented from spec state only: resolve the spec execution from the workflow execution id (unlinked merges pass through); load pinned (revision, scope), dispositions, verdicts, and evidence; apply freshness against the prepared candidate (ancestry, relevant-tree comparison); accept only proven, validly waived, or delivered-by-earlier-merged-execution; refuse otherwise listing unmet criteria with the re-dispatch instruction; report deferred criteria visibly without blocking; never read the workflow definition
  - Candidate-proof bridge: with a changed relevant tree and an applicable passing candidate-validation fact, append gate-side test/validator evidence resolving to the job fact and issue fresh deterministic verdicts idempotently by validationRef; a fact covering an older tree refuses until a fresh dispatch re-validates
  - Done when: tests cover the acceptance matrix, refusal listing unmet criteria, deferred visibility, pass-through without linkage, and idempotent gate-side verdict issuance
  - _Requirements: 11.7, 13.9, 13.10, 13.11, 18.1, 18.2, 18.3, 18.4, 18.5_
  - _Depends: 2.7, 5.2, 7.1, 9.1, 9.4_
  - _Boundary: DeliveryGateAdapter_

- [x] 10. Links service: promote, graduate, materialize, read through
  - Promotion links a conversation as source with an immutable snapshot of the exact message versions and attachment versions (content-store backed) that survives later source edits; graduation seeds intent sections from ticket description/attachments, links graduated-from, and leaves the ticket a ticket tracking delivery-level status; materialization creates linked tickets from approved tasks via the ticket service; exactly one spec object per entry path
  - Read-through queries answer ticket-side display (phase, criteria progress, linked task status, source-task-removed/changed) from current spec state at render time; spec-derived state never writes ticket-owned fields
  - Done when: integration tests show promotion snapshots surviving source edits, graduation seeding and linking, materialization creating linked tickets, and read-through queries computing display state with no stored mirror
  - _Requirements: 2.16, 4.3, 4.4, 4.5, 4.6, 15.1, 15.2, 15.3, 15.4, 15.5, 15.6_

- [x] 11. Spec HTTP route surface
- [x] 11.1 Read routes and resolution
  - Route-resolution adapters for project-scoped spec addressing with alias-aware slug resolution; read endpoints for inventory, full/summary views, status (phase, gate states, pending approvals, open questions, coverage), single element with approval and evidence state, current-draft lint findings (the same list refusals return), and text search over requirements and decisions
  - Done when: route tests cover alias-resolved reads, status payload completeness, the lint-findings read matching predicate output, and 404s through the shared resolution ladder
  - _Requirements: 1.6, 2.14, 6.3_

- [x] 11.2 Write routes with actor and human-act enforcement
  - Write endpoints for every service mutation; transport identity discriminates actors (cctl bearer token = agent with originating conversation; browser session on UI routes = human without fabricated agent or conversation); approval grants, waiver grants, and policy changes from agent transport refuse as human-act-required (403); all other refusals ride HTTP 409 with the shared refusal body; client query/mutation/key factories follow the domain pattern
  - Done when: route tests cover the status-code table (409 refusals, 403 human-act, 400/404 validation), actor provenance recorded from both transports, and an agent approval attempt refused
  - _Requirements: 6.1, 6.5, 6.7, 10.2_

- [x] 12. cctl spec command family
- [x] 12.1 Shared failure-envelope extension
  - Additive extension of the shared CLI failure envelope: server instruction plus code-discriminated details (lint finding lists for lint-blocked, current content and version for stale-element); 409 maps to exit 1 with instruction, 400/422 to exit 2; a shared-classifier completion usable by every cctl family
  - Done when: the contract test pins the full status/code/exit/issues/instruction matrix including lint_blocked and stale_element payloads
  - _Requirements: 6.2, 6.5, 7.3_

- [x] 12.2 Read verbs
  - list, show, status, get, search, export, verify following the CLI contract (progressive-disclosure help-registry entries, --json envelope, typed exit codes, deterministic local validation); bare element handles accepted where the slug is already present; export writes the canonical bundle and verify recomputes integrity
  - Done when: each verb returns typed output against a seeded server; status shows phase, gates, pending approvals, open questions, and coverage; verify exits 1 on a tampered spec; help renders through the registry
  - _Requirements: 1.3, 1.4, 6.2, 6.3, 6.8_

- [x] 12.3 Write verbs
  - create, draft (base-versioned element writes), propose, answer, assume, task complete (evidence refs required), request-approval, start (schema-backed scope file validated locally before network), abandon (reason required); no policy, sign-off, or verdict verbs exist
  - Gate refusals exit 1 with code, unmet conditions, and instruction; local validation failures exit 2 without contacting the server
  - Done when: integration tests cover propose printing the finding list on refusal, task complete without evidence exiting 1 with instruction, start with an invalid scope file failing locally with exit 2, and a draft conflict surfacing current content
  - _Requirements: 3.10, 6.1, 6.4, 6.5, 6.6, 16.1_

- [x] 13. `/spec` entry command and elicitation
  - The /spec command (composer and CLI, native slash-command path) starts spec authoring in a conversation, instructing the agent to author through cctl spec with create-on-first-save; elicitation stays conversation-side with skippable, visible, prunable question batches; the server never blocks on elicitation; conversations author while Studio reviews
  - Done when: invoking /spec from the composer starts an authoring conversation whose first draft save creates the durable spec object — returned by `cctl spec list` and the read routes immediately — and the command instructions carry the elicitation etiquette
  - _Requirements: 4.1, 4.7, 11.11_
  - _Depends: 12.3_

- [x] 14. Liveness, attention, and measures wiring
- [x] 14.1 (P) Client SSE reactions and cache reducers
  - Spec event listeners registered with the notification listener; pure cache reducers apply event deltas (tickets pattern) with pending-overlay reconciliation; spec chips and surfaces update as events occur with no polling and no stale approval banners
  - Done when: reducer unit tests cover each of the six event types and a cache seeded with a stale approval banner clears on the approval event
  - _Requirements: 19.2_
  - _Depends: 7.2_
  - _Boundary: spec sse-reactions, sse-reducer, pending-overlay_

- [x] 14.2 (P) Attention adapters and notifications
  - Executions in definition review or running appear in Active Work; pending gate requests appear in Needs You deep-linked to the exact decision; new spec notification types fire per user settings; granting an approval unblocks the waiting agent observably (next status read or queued-turn nudge)
  - Done when: adapter tests show a gate request surfacing in Needs You with its deep link, notification rows created per settings, and a granted approval observable on the agent's next status read
  - _Requirements: 10.9, 19.3_
  - _Depends: 7.2_
  - _Boundary: active-work adapters, notifications_

- [x] 14.3 (P) Measures surface
  - The four measures and the frozen definitions version exposed through the CLI measures verb, computed over the durable event log; the version recorded in the event log so the pilot can freeze definitions; the reviewer-navigation chain (requirement → approved revision → task → changed code → valid proof → merge result) computable per delivered criterion
  - Done when: the measures verb outputs all four measures with the version from a seeded database, and a navigation-chain query returns a complete chain for a delivered criterion without transcript access
  - _Requirements: 20.1, 20.2, 20.3, 20.4_
  - _Depends: 2.8, 12.2_
  - _Boundary: measures, cli_

- [x] 15. Unified picker spec types and chips
- [x] 15.1 Spec reference tags and registry entries
  - Four spec node types and tags (spec, requirement, decision, task) carrying slug/handle/name, the revision observed at insert, and an embedded read command so references behave as addresses, never content dumps; serializer, parser, segmenter, and paste flow through the registry
  - Done when: round-trip tests serialize and parse all four tags, and pasting copied reference text produces the matching chip
  - _Requirements: 5.3, 5.5, 5.8, 5.9, 5.10_
  - _Depends: 6.1, 11.1_

- [x] 15.2 Drill-in picker
  - The unified picker matches specs on slug and name with current-project specs listed first; continuing the query below a selected spec offers that spec's requirements, decisions, and tasks matched on handle and statement text; selection inserts the corresponding chip kind
  - Done when: typing `#` lists grouped specs among other types, a slug-qualified query lists the spec's elements, and each selection inserts the correct chip
  - _Requirements: 5.1, 5.2, 5.4_
  - _Boundary: unified mention popup_

- [x] 15.3 (P) Live chips, hover peek, staleness, copy-reference
  - Transcript and editor chips resolve live state: spec chips show name plus current phase with click-through and a hover peek (phase, requirement counts, approval state); element chips show the slug-qualified handle with statement, deep-linking to the element; the changed/stale indicator compares the element's content hash at the observed revision against the latest containing revision including drafts; Studio copy-reference controls emit tag text that pastes to the same chip
  - Done when: a chip updates its phase from a published event, the stale indicator appears when element content changed and clears when a draft restores it, and copy-paste round-trips to an identical chip
  - _Requirements: 1.4, 5.6, 5.7, 5.8, 5.9_
  - _Depends: 15.1_
  - _Boundary: reference chips components_

- [x] 16. Spec Studio
- [x] 16.1 Routes, list page, and navigation
  - /specs as a navigation peer of tickets and conversations: the spec list with composite phase chips, pending-approval badges, linked-work roll-ups, and project filtering; the detail route resolves project plus slug alias-aware; partial delivery renders as a roll-up badge, never a stored phase
  - Done when: the list renders seeded specs with phase and facet badges and partial-delivery roll-ups, the navigation entry appears, and a renamed spec's old link still resolves
  - _Requirements: 1.6, 3.11, 8.1_

- [x] 16.2 Detail view: prose, rail, facets, deep links
  - Prose sections render as annotated markdown with inline comments alongside the structured rail (requirements, decisions, tasks with per-item status and approval state); live updates through the reducers as agents change the spec; the phase header always shows the composite primary plus authoring facet and delivery standing (all-waived flagged explicitly); deep links (?el=) open scrolled to the element; no content-editing affordances exist in V1
  - Done when: an agent draft write appears in an open Studio view without refresh, a deep link scrolls to its element, the facet header shows Executing with a concurrent In-review facet, and the all-waived delivery condition displays explicitly
  - _Requirements: 1.5, 2.3, 3.6, 3.8, 4.7, 7.2, 8.2, 8.3_

- [x] 16.3 Review mode: change list, four actions, comment threads
  - The semantic change list for a proposed revision (element-level add/remove/modify with kind-aware summaries, per-change deep links, inline approve/comment) with the raw diff as a secondary view; the four review actions wired to the service; modified elements show side-by-side change for re-approval; comment threads persist across revisions with original revision and range, re-anchoring only on unambiguous relocation and otherwise presented stale/orphaned
  - Done when: a proposed revision renders its change list with side-by-side re-approval, request-changes opens the follow-up draft, and an orphaned thread shows its stale presentation instead of silently re-attaching
  - _Requirements: 8.4, 8.5, 8.6, 10.5_

- [x] 16.4 (P) Evidence, lint, and traceability views
  - The evidence view answers "what proves this?" per acceptance criterion — attached evidence and verdicts against the approved validation strategy, or nothing-proves-it-yet — never rolled up per task; the lint panel lists findings deep-linked to elements, updating as the draft changes, identical to refusal lists; the traceability view renders the requirement → decision → task → execution → evidence graph with findings in place
  - Done when: the evidence view renders per-criterion proof state, the lint panel list matches a refused propose response exactly, and the traceability graph navigates to elements
  - _Requirements: 8.8, 8.9, 9.10_
  - _Depends: 16.2_
  - _Boundary: evidence panel, lint panel, traceability graph_

- [x] 16.5 (P) Bulk approval, policy, execution, and integrity controls
  - Bulk approval ("approve all requirements", "approve all remaining") recording the same per-element state as individual approval (the individual four actions are task 16.3's); the policy dialog with hard non-bypassable confirmation for preset switches and gate loosening, prospective-only; the execution panel to start a run (scope selection), watch definition review, and link to the workflow surface; waiver grant and disposition controls recording the human act with reason; the integrity banner surfaces tamper detection
  - Done when: bulk approval writes per-element records visible in the rail, loosening a dial requires the hard confirm, a waiver grant records the human act with its reason, and a verify mismatch shows the banner
  - _Requirements: 2.5, 8.7, 10.2, 11.10, 14.2, 16.1_
  - _Depends: 16.2, 16.3_
  - _Boundary: policy dialog, execution panel, bulk approval_

- [x] 17. (P) Ticket read-through display and graduation
  - Ticket detail shows the linked spec chip with live phase, criteria progress, and linked task status computed through the link at render time; a materialized task removed or re-scoped by amendment displays the source-task-removed/changed state; the graduate action creates the spec from the ticket; ticket lifecycle stays ticket-owned with display-only integration in V1; both link directions are citable as chips
  - Done when: a ticket shows live spec phase with no stored mirror, an amendment re-scoping a materialized task changes the ticket display, and graduating a ticket opens the seeded spec
  - _Requirements: 15.1, 15.2, 15.4, 15.5, 15.6_
  - _Depends: 10, 15.3, 16.1_
  - _Boundary: tickets feature UI_

- [x] 18. Execution activation and closure
- [x] 18.1 Composition wiring for the live gate
  - The workflow join dispatch passes the execution id into merge input; composition injects the delivery-gate adapter and the lifecycle callbacks (markRunning, markDelivered) at the merge-runner seam; land re-entry of a parked candidate rebuilds execution id and validation fact from the persisted job and is gated identically; non-spec merges remain pass-through
  - Done when: an integration test drives a spec-linked workflow merge through the gate while a non-spec merge is unaffected, and a parked candidate landed later is still gated
  - _Requirements: 17.2, 18.1, 18.6_
  - _Depends: 5.2, 9.5, 9.6, 9.7_

- [x] 18.2 Candidate-proof closure
  - The full bridge proven: validate candidate A, CAS re-prepare to B with a changed relevant tree, the gate refuses (A's fact does not cover B) until a fresh dispatch validates B, gate-side verdict issuance stays idempotent by validationRef, publish succeeds, and Delivered lands exactly once despite a replayed callback
  - Done when: the closure integration test passes end-to-end with exactly-once Delivered and no duplicate verdicts
  - _Requirements: 13.9, 13.10, 13.11, 18.6_

- [x] 19. End-to-end validation
- [x] 19.1 Golden-path E2E
  - The full spine driven live: /spec authoring → draft visible in Studio → propose → change-list review → approve and sign off → execution start → definition review → running with evidence flow-back → delivery gate → Delivered with per-criterion proof navigable in the evidence view
  - Done when: the E2E run completes with Studio live-updating throughout (no refresh), and every in-scope criterion shows its proof chain
  - _Requirements: 19.2, 21.1_

- [x] 19.2 Refusal demonstrations
  - Live tests of the server refusing each illegal transition: execution start pinning a non-approved revision, a task completion claim without acceptable evidence, and a merge with a selected criterion in no acceptable state; each refusal surfaces through CLI and UI and lands in the durable event log
  - Done when: all three refusals are demonstrated with machine-readable codes, and the event log records each intervention for the release evidence
  - _Requirements: 21.3, 21.4_

- [x] 19.3 Release-evidence navigation check
  - From captured state only, an independent-reviewer navigation reconstructs requirement → approved revision → task → changed code → valid proof → merge result for every delivered in-scope criterion of the golden-path feature, with no transcript access and no manual bookkeeping step
  - Done when: the navigation check passes over the golden-path run's captured events and the traceability-completeness measure reports full coverage
  - _Requirements: 20.2, 20.3, 21.2_
