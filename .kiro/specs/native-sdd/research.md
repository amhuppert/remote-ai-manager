# Research & Design Decisions: native-sdd

- **Feature**: `native-sdd`
- **Discovery Scope**: Complex Integration / New Feature (full discovery)
- **Structure**: §1–7 are the gap analysis (2026-07-17, `/kiro-validate-gap`). §8–10 are the design-phase research log, synthesis decisions, and risks (2026-07-18, `/kiro-spec-design`).

---

# Part I — Gap Analysis (2026-07-17)

**Date:** 2026-07-17 · **Inputs:** `requirements.md` (21 requirements, generated, not yet approved), `docs/design/native-sdd/01-product-design.md` rev 5, core steering, seven parallel codebase investigations.
**Method:** parallel subsystem research (persistence, tickets, references/chips, cctl, graph workflows + merge, events/attention, UI foundations) → requirement-to-asset mapping → approach options.

---

## 1. Current-State Summary by Subsystem

### 1.1 Persistence / state-store (`src/lib/state-store/`)

The recipe for a new persisted domain is well-worn: schema-floor DDL in `state-db.ts` (`CREATE … IF NOT EXISTS`, runs on every open), a repo per table with Zod-validated round-trips and `stableStringify` serialization, a `*.contract.test.ts` using the round-trip durability harness (`src/lib/shared/testing/round-trip-durability.ts`) with field policies (`not-persisted`, `derived-on-write`), `createPersistenceFixture()` (`src/lib/shared/testing/persistence-fixture.ts`) for real-SQLite tests, the FIFO write queue, a service layer with injected deps (`tickets/service.ts` is the exemplar: repo + publish + operation locks + typed result unions), and thin route handlers mapping typed errors to HTTP.

Relevant precedents:
- **Append-only log**: `graph-workflow-events-repo.ts` (`graph_workflow_events`, AUTOINCREMENT, append-only) — model for evidence records and spec event retention.
- **Version table with approver**: `session_alignment_versions` (`version`, `content`, `content_hash`, `status`, `approver`, `activated_at`) + `session_alignment_decisions` — closest precedent for immutable approved revisions.
- **Content-hash-gated writes**: `graph-workflow-executions-repo.ts` splits definition/runtime tiers, rewrites definition only on hash change.

**ABSENT anywhere in the codebase:** optimistic concurrency (no version-checked writes, no typed `ConflictError`), tamper-evidence beyond stored `content_hash` (no hash chains/signatures), alias/rename resolution (no alias table; all identities immutable), revision model for a *structured element tree* (alignment versions store one content blob).

### 1.2 Tickets — the closest durable-object analog (`src/lib/tickets/`, ~65 files)

- **Identity**: per-project sequential number via `ticket_counters`; display form `project#N` (`references.ts`: `formatTicketIdentifier`, `parseTicketIdentifier`, `buildTicketReadCommand`). **No slugs, no aliases, no sub-element handles.**
- **Links**: no generic relation table — `ticket_attachments.payload_json` is a five-kind discriminated union (`file` | `conversation` | `session` | `related_ticket` | `note`). `ticket_sessions` is a dedicated relation table with lifecycle (at most one active link, unbounded history). No provenance direction/category metadata beyond the discriminator.
- **Immutable snapshots**: content-store (`ticket-content/<ticket>/<attachment>/<basename>`, sha256, size), conversation attachments in two modes (`live_compaction` read-through vs `retained_compaction` snapshot), `related_ticket` identifier snapshots with `available: false` degradation — the model for R4.5 exact-source-version provenance.
- **Read-through display**: only the compaction attachment does live read-through; **no generalized "object A shows object B's live state through a link" pattern** (needed for R15.5).
- **Live updates**: `ticket-changed` SSE event + pure idempotent `sse-reducer.ts` + `pending-overlay.ts` reconciling optimistic mutations with deltas — the pattern Spec Studio list/detail should copy.
- **Surfaces**: board/list/detail in `src/features/tickets/`, `TicketMentionChip`/`TicketRefLinkChip` in conversations, `cctl ticket` (~800-line command file), `/ticket` slash command with structured output.

### 1.3 References and chips (`src/lib/prompt-editor/`, `src/lib/conversations/ref-*`)

- `#` currently triggers **two separate Tiptap suggestion extensions** (conversation + ticket) — a unified grouped picker (R5.1) does not exist. `@` is file mentions.
- Wire format: chips serialize to XML tags in `serializer.ts` — `<conversation-ref/>` (rich: status, compaction fields, embedded `read-command`/`compaction-command`), `<ticket-ref/>`, `<message-ref/>`. Paste-to-chip: `ref-paste-extension.ts` → `ref-segments.ts`/`ref-parser.ts`.
- **Resolution is command-embedding, not server-side**: tags carry `read-command="cctl … "` strings the agent runs verbatim. This already matches R5.10 (reference as address, content pulled through the agent surface).
- Staleness precedent: `compact-status="fresh|stale|none"` + `compact-covered-seq` — partial precedent for R5.9 revision-observed recording.
- **ABSENT**: hover/peek on chips, a type registry — adding a new reference type today means **five hardcoded integration points** (node type, extension + popup, serializer case, parser function, paste-segment case). Drill-in (`#slug/R3` continuing below a selected entity) has no precedent in the suggestion plumbing.

### 1.4 cctl CLI (`src/cli/`)

Everything R6 needs structurally exists and is contract-tested:
- Help registry SSOT (`help-registry.ts`, colocated `*.help.ts` entries, `help-registry.contract.test.ts` enforcing dispatch↔registry agreement), `dispatchGroup()` for verb families.
- Output contract (`shared.ts`): exit codes 0/1/2/3/4; `JsonEnvelope` with `ok/error/code/issues/hint/reminders/instruction`; three-tier semantics are steering-binding (`.kiro/steering/cli.md`).
- Deterministic local validation before network (flags → `--file` parse → identity resolution, all exit 2) — the R6.2 pattern.
- Machine-readable refusal precedent: exit 1 + `code` + `issues[]` + `reminders[]` + `instruction` (e.g. `NO_DEV_SERVERS_CONFIGURED`, lane-halt 409 handling). R6.5's "failure code + unmet condition + next-step instruction" maps directly onto `code` + `issues` + `instruction`; **no new exit-code taxonomy needed**.
- Identity/provenance: `CC_CONVERSATION_ID`/`CC_PROJECT`/`CC_SESSION` env injection + bearer token → server can record agent + originating conversation (R6.7). Human acts arrive via UI routes, not cctl — the actor split falls out of the transport.
- **ABSENT**: any export/verify precedent (R6.8 is new ground).

### 1.5 Graph workflows and merge (`src/lib/workflow-graph/`, `src/lib/workflows/merge/`)

- Definition schema (`definition-schemas.ts`) already models what spec compilation targets: `executionContexts[]` (with `acceptanceCriteria`), `tasks[]`, `edges[]`, validators, charter, parameters — R17.1's compile target is a real, validated artifact class.
- Executions already pin: `seedDefinitionId` + `seedDefinitionRevision` + `workingDefinition` snapshot — precedent for R16 pinning semantics.
- Context-level human approval gate exists **mid-execution** (`approval-gate.ts`: `awaiting_approval` status, atomic first-decision-wins `recordDecision`, loop polls ~1s and resumes) — the unblocking mechanism R10.9 needs.
- Validator machinery produces verdict records (`graph-workflow-validation-result` events: pass, summary, issues, `reviewArtifact` with backend/turn ref) and lanes track `commitSnapshots[]` `{contextId, sha, committedAt}` — the raw material for R13.5 auto-attachment, **but nothing is criteria-keyed today**.
- Merge machine phases: committing → merging → conflict analysis → validating → fixing → preparing → publishing; pre-merge validation script gates the fix loop. **The merge gate reads only validation-script output + conflict state — there is no interposition seam for an external criteria gate (R18).**
- **ABSENT — the three general capabilities of R17.5**: definition-level approval before start (creation/replace are immediate), origin links (definitions record nothing about where they came from), provenance-locked regions (`definition-edits.ts` applies batch ops with structural validation but has no read-only-region concept).

### 1.6 Events, attention, notifications (`src/lib/events/`, sidebar)

Complete, documented recipe — R19 is almost pure pattern-following:
- Publish through `publication.ts` (`publishEvent`/`publishEventBestEffort`, never throws); event schemas per domain in `src/lib/<domain>/schemas.ts`; union in `src/lib/api/sse-events.ts`; client reactions registered in `NotificationListener.tsx` via `addSseListener` (safeParse, drop invalid); known gotcha: strict envelope schemas drop events carrying undeclared fields.
- Active Work / Needs You: `active-work-adapters.ts` adapts domain sources to `ActiveWorkItem` (with `needsAction`) and `AttentionItem`; jobs/workflows/collabs are the exemplars; new domains add an adapter + (for persisted attention) a notification type.
- Notifications: terminal states persist `Notification` rows + `notification-created` events → toasts + Activities panel.
- Agent unblocking: approval resolution is observed by the waiting loop's next poll; queued-turn machinery (`message-queue-drain.ts`) exists for nudges. No push-nudge on approval today — polling-observation is the accepted pattern.
- **ABSENT**: per-domain event-name constants files (names live in schema literals — fine to follow).

### 1.7 UI foundations for Spec Studio

- **Design bundle**: `claude-design/spec-driven-development-ui/` (3.6 MB, 29 files, one primary HTML prototype + DS bundle). Screens: spec list (phase chips, approval badges), detail with annotation gutter + structured rail, traceability graph, per-criterion evidence panel, project-scoped tab navigation.
- **Annotated markdown is production-ready**: `AnnotatedMarkdown.tsx` + recogito boundary + `CommentCard`/`CommentPopover`/`CommentGutterPin`, jsdom escape hatch `_setAnnotatorBoundaryForTesting`. Directly reusable for R8.2.
- **Comment persistence exists but is scoped wrong for specs**: `document-comments-repo.ts` keys on `(project_path, session_name, doc_path)` with anchor (`section_id`, line, char range, quote, `doc_revision`) and `pending|sent` status. **No threads (no replies), no re-anchoring algorithm, session-scoped not spec-scoped** — R8.6 needs a generalization or a parallel spec-comments model.
- Navigation: project cockpit tabs (`ProjectCockpit.tsx`, `use-cockpit-view-state.ts`) — Spec Studio registers as a peer tab/route under `/projects/[name]/`.
- Primitives ready: `StatusChip`, `Tabs`, `Dialog`, `Badge`, `Collapsible`, `Accordion`, `EmptyState`, `MarkdownRenderer`/`MarkdownViewport`; xyflow-based `workflow-graph/AutoLayout.tsx` + node/edge renderers adaptable for the traceability graph (R8.9).
- Storybook: colocated stories, a11y/vitest addons, established `ui-design` flow.
- **ABSENT**: semantic change-list UI (R8.4), evidence view, any threaded review UI.

---

## 2. Requirement-to-Asset Map

Tags: **HAVE** (direct reuse), **EXTEND** (pattern exists, needs generalization), **MISSING** (build new), **UNKNOWN** (research needed in design), **CONSTRAINT**.

| Req | Existing assets | Gap |
|---|---|---|
| R1 identity/handles/deep links | Ticket `project#N` identity + parse/format (`tickets/references.ts`); per-domain routes | **MISSING** slug identity, per-spec element counters (`R3.2`, `D2`, `T7`), bare-handle context resolution, alias table for renames (no precedent anywhere). Deep-link-to-element scroll is new UI. |
| R2 durable objects/revisions/element identity | State-store recipe; `session_alignment_versions` (immutable versions + approver + content_hash); content-hash-gated writes | **MISSING** revision model for a structured element tree with stable element identity across revisions; tamper-evidence (R2.5) beyond a stored hash. **UNKNOWN** authored-content storage shape (explicitly a design-phase decision). **CONSTRAINT** one authoritative representation (§3 invariant) + shared `command-center.db` across branches (new tables → older builds read-quarantine rows). |
| R3 derived phase projection | Derived-status precedents are small (ticket session-link `active`) | **MISSING** but self-contained pure logic: phase projection with Executing-primary/secondary-facet precedence; no stored phase. Low integration risk. |
| R4 entry paths + provenance | Slash-command precedent (`/ticket` with structured output; native slash commands reach agents via SDK); ticket snapshot machinery (sha256 file snapshots, retained compaction) for exact-source capture | **EXTEND**: `/spec` command + create-on-first-save; conversation promotion is new but composes existing pieces. Graduation detailed in R15. |
| R5 unified `#` picker + drill-in + chips | Two `#` extensions, XML tag serialization, paste-to-chip, embedded read-commands (already matches R5.10), `compact-status` staleness precedent | **EXTEND→MISSING**: unified grouped type-filterable picker replaces two parallel extensions; drill-in below a selected spec has no precedent; hover/peek ABSENT; revision-observed + stale indicator new. Per-type integration currently costs 5 hardcoded touchpoints — registry refactor decision needed (§3.2). |
| R6 `cctl spec` family | Full CLI contract: registry SSOT, envelope, tiers, exit codes, local validation, identity env vars, machine-readable refusal precedent | **EXTEND** for reads/writes/refusals (map R6.5 onto `code`+`issues`+`instruction`). **MISSING**: export/verify (R6.8) — no precedent; design must define the portable representation (ties to the recoverable-representation invariant). |
| R7 concurrent element-granular authoring | SSE live visibility; write-queue serialization | **MISSING**: optimistic concurrency is absent codebase-wide — element version-checked writes + typed conflict-with-current-content response is a new pattern (server + cctl + UI). |
| R8 Spec Studio | AnnotatedMarkdown + recogito (READY); document-comments repo (single comments, anchors with `doc_revision`); cockpit tabs; StatusChip/Tabs/Dialog; xyflow graph; ticket sse-reducer/pending-overlay pattern | **EXTEND**: comments → spec-scoped, threaded, revision-anchored with explicit stale/orphaned handling (re-anchoring algorithm UNKNOWN). **MISSING**: semantic change list, four review actions wired to approval state, evidence view, traceability view (xyflow adaptation). |
| R9 deterministic lint | Definition validation precedents (`validateAuthoredDefinition` DAG checks) | **MISSING** but self-contained: pure findings computation over structured state + refusal wiring at propose/claim/sign-off + panel UI. Requirements are the authoritative catalog — low ambiguity. |
| R10 approvals + sign-off + invalidation | Alignment approver/decision records; workflow context approval gate (atomic decision, resume-on-poll); Needs You precedent via workflow approval events | **MISSING**: per-element durable approval records, approval-vs-gate-admission distinction, unchanged/modified/removed classification at propose with carry-forward/stale/closed, sign-off transition preconditions. Classification algorithm interacts with element identity (UNKNOWN, design). |
| R11 presets/dials/floor | Server-refusal precedents (409s, typed errors) | **MISSING**: policy engine (preset + sparse overrides, five gates × three dial values, floor rules, fast-path atomic combined approval, hard-confirmation on loosening). Pure new domain logic; enforcement points thread through every transition. |
| R12 open questions/assumptions | AskUserQuestion machinery (asking); no disposition records | **MISSING**, small: two addressable record types with lifecycles + amendment trigger on disposition change of cited assumptions. |
| R13 evidence + proof verdicts | Validator verdicts w/ review artifacts; lane `commitSnapshots`; append-only events repo; ticket content-store (screenshots) | **MISSING**: criteria-keyed evidence records (append-only), server-resolvable reference validation, proof-verdict layer distinct from evidence, freshness rules (pure-rebase tree identity, captured-surface staleness), auto-attachment from execution surfaces (maps validator/commit events → criteria via compiled provenance). Largest genuinely new server subsystem alongside R10/R11. |
| R14 waivers/dispositions | — | **MISSING**, small-medium: per-(criterion, revision, scope) disposition state + human-only waiver records + staleness on later change. |
| R15 ticket↔spec links | Ticket attachment union (extensible), `ticket_sessions` relation-table precedent, `related_ticket` snapshot degradation, compaction read-through (only live read-through precedent) | **EXTEND/MISSING**: provenance-bearing link records (direction + category per R2.15), graduation flow, task materialization, generalized read-through display on tickets (spec-derived fields never writing ticket-owned fields). Generic-vs-specialized link storage is a design decision (§3.3). |
| R16 execution pinning/scope | `seedDefinitionId`/`seedDefinitionRevision` pinning; one-active-execution-per-session lookup | **EXTEND**: (revision, scope) pin as first-class spec-side state; one-active-per-spec (session-scoped precedent, different key); **MISSING**: scope validation (dependency closure, coverage, excluded-criterion dispositions, plan-defined valid subsets), scope-amendment capture. |
| R17 compilation + 3 general workflow capabilities | Rich definition schema (contexts/tasks/edges/ACs/validators); definition-edits batch validation | **MISSING**: compiler (new pure transform, spec-side); and in workflow domain — definition approval before start, origin links, provenance-locked regions (all three ABSENT; must land as general capabilities with no SDD special-casing per adjacent-expectations). |
| R18 delivery gate on spec criteria | Merge machine with phases + pre-merge validation hook | **MISSING**: an interposition seam — today's gate reads only validation-script output; a delivery-gate evaluator reading spec (revision, scope) criteria states must be injected without the workflow definition being able to weaken it. Seam placement UNKNOWN (design). |
| R19 liveness/attention | Complete recipe: publication seam, per-domain schemas, sse-reactions, active-work adapters, notifications, approval-resume-on-poll | **EXTEND**, lowest-risk requirement: define spec event catalog, reactions, adapters, notification types. Mind the strict-envelope drop gotcha. |
| R20 §6.1 instrumentation | Append-only events precedent (`graph_workflow_events`) | **EXTEND/MISSING**: durable retention of spec events sufficient for the four measures, recorded measure definitions, reviewer navigation path (falls out of R13/R18 keys if evidence is criteria-keyed). Must be day-one (unreconstructable later). |
| R21 release acceptance | — | Process requirement over everything; refusal demonstrations map to R16.3/R6.6/R18.4 enforcement points. |

---

## 3. Implementation Approach Options

The macro-shape is not really in question — a new `src/lib/specs/` domain following the tickets exemplar (schemas, repo(s), service, route-handlers, queries/mutations/query-keys, sse-reducer, cctl family, feature UI) plus **general** extensions to four existing subsystems (prompt-editor references, workflow definitions, merge gate, ticket links). That is the Hybrid option by construction. The real option-branches are per-axis:

### 3.1 Authored-content storage (design-phase decision, per boundary context)

- **A — Fully structured**: every element (requirement, criterion, decision, task, section) a row; prose section bodies as text columns; revisions as immutable row-sets keyed by revision id.
  - ✅ Element-stable identity, element-granular concurrency (R7), semantic change classification (R10.5), and lint (R9) all fall out naturally; single authoritative representation is trivially true.
  - ❌ Export/verify (R6.8) and "prose-first markdown sections" (R2.3) need a deterministic projection; inline annotation anchors must map to rendered projections.
- **B — Document-primary**: markdown document per revision (à la `.kiro/specs/` or alignment versions) + derived structured index.
  - ✅ Matches prose-first authoring and the existing AnnotatedMarkdown anchor model; export is nearly free.
  - ❌ Element identity across edits, element-granular optimistic writes, and change classification against a text blob are hard; risks a silent second truth (index vs document) violating R2.14.
- **C — Hybrid (structured spine + prose bodies)**: structured element tree owns identity/relations/approvals; each prose-bearing element stores its markdown body; revision = immutable snapshot of the tree (content-addressed, alignment-style `content_hash` per revision for tamper evidence); export renders a canonical markdown+manifest projection, verify re-hashes it.
  - ✅ Serves all six invariants; both R7 concurrency and R8 annotation anchor per element; the semantic change list diffs the tree, not text.
  - ❌ Most schema surface; anchor model spans element body offsets (annotation re-anchoring per element body, which is actually smaller/easier than whole-document).

Gap-analysis lean: **C**, with A as the fallback if per-element prose bodies prove enough (they likely are — "prose-first sections" are themselves elements). B conflicts with R2.14/R7 and should be argued against explicitly in the design doc.

### 3.2 Reference/chip integration

- **A — Sixth hardcoded type ×4 tags**: add spec/requirement/decision/task mention nodes through the existing five touchpoints each.
  - ✅ No refactor risk; ❌ ~20 hardcoded integration points, and the unified picker (R5.1) still forces restructuring the two existing `#` extensions anyway.
- **B — Registry-first refactor**: introduce a reference-type registry (node type, tag name, attr schema, parser, chip renderer, picker source) and migrate conversation/ticket/message types onto it, then add spec types; build the unified picker + drill-in on top.
  - ✅ R5.1 requires merging the pickers regardless; four new spec reference kinds amortize the refactor; future domains plug in.
  - ❌ Touches working conversation-input code; needs parity-careful migration.

Lean: **B** — R5.1 (one unified picker) cannot be satisfied by stacking a third parallel extension, so the restructuring is mandatory; the registry is the honest shape of it.

### 3.3 Ticket↔spec links

- **A — Extend the attachment union** with `spec` payload kinds (mirrors `related_ticket`).
  - ✅ Cheap; ❌ attachment semantics (snapshot-at-attach) are wrong for live read-through (R15.5), and provenance direction/category (R2.15) doesn't fit the union.
- **B — New `spec_links` relation table** (subject, object, direction, category: graduated-from / materialized-from / reference), following the `ticket_sessions` dedicated-table precedent; read-through display queries spec state through the link at render time.
  - ✅ Matches R2.15's provenance-bearing links for *all* related objects (tickets, conversations, sessions, executions, merge jobs), one mechanism; ❌ new query surfaces on both sides.

Lean: **B** — R2.15 names link direction/category as first-class, and links span five object kinds, not just tickets.

### 3.4 Comments

- **A — Generalize `document-comments`** to polymorphic scope (session-doc | spec-element) + threads + resolution state.
- **B — New spec-comments model** copying the anchor design, leaving session document comments untouched.

Lean: **B** initially (the existing table is session-scoped with a `pending|sent` lifecycle that doesn't match review threads with blocking/resolved states); revisit consolidation later. The *UI* layer (AnnotatedMarkdown, gutter, cards) is shared either way.

### 3.5 Workflow general capabilities (R17.5)

Build the three capabilities inside the workflow domain as independent increments **before** the compiler consumes them: (1) `approvalRequired`/approval state on definitions gating execution seed; (2) optional `origin` on definitions (+ per-context origin links); (3) `lockedRegions` (path-addressed, with source link) enforced in `definition-edits.ts` with an amend-at-source refusal. Each is independently testable and useful without SDD (aligns with the standing "workflow features stay general" constraint).

### 3.6 Delivery gate seam (R18)

Options: (a) a delivery-gate evaluator injected into the merge machine's validating/preparing phase; (b) a precondition check in `graph-merge-runner` before the final-publish join proceeds. Either way the evaluator must read spec state (pinned revision + scope criteria dispositions/proof), not the definition. Exact placement: **Research Needed** (halt/repair interaction, fix-loop semantics on refusal).

---

## 4. Effort & Risk by Area

| Area | Effort | Risk | Justification |
|---|---|---|---|
| Spec domain core (R1–R4, R12): schemas, repos, revisions, phase projection, entry paths | **XL** | **High** | Largest new schema surface; revision/element-identity model is novel here; everything else keys on it. |
| Approvals + policy engine (R10, R11) | **L** | **High** | New invariant-dense state machine; classification-at-propose correctness is subtle; enforcement threads through every transition. |
| Evidence/proof/waivers (R13, R14) | **L** | **High** | New criteria-keyed subsystem + freshness rules + resolvable-reference validation; correctness is the product thesis. |
| `cctl spec` (R6) | **M** | **Low** | Pure pattern-following on a contract-tested CLI foundation; export/verify is the only novel part. |
| Concurrent authoring (R7) | **M** | **Medium** | First optimistic-concurrency implementation in the codebase; conceptually standard, integration-tested against SSE visibility. |
| Unified references (R5) + registry refactor | **L** | **Medium** | Touches live composer code; drill-in UX novel; migration must hold parity for existing chips. |
| Spec Studio (R8) | **XL** | **Medium** | Big UI surface but on ready foundations (annotation stack, primitives, cockpit, xyflow); semantic change list and evidence/traceability views are new compositions; design bundle fixes the target. |
| Lint (R9) | **M** | **Low** | Deterministic pure functions over structured state; catalog fully specified in requirements. |
| Workflow capabilities + compiler + pinning (R16, R17) | **L** | **Medium** | Three general capabilities are bounded edits to a mature subsystem; compiler is a pure transform onto an existing validated schema. |
| Delivery gate (R18) | **M** | **High** | Small code, high stakes: seam placement in merge machinery where a mistake silently weakens the core guarantee. |
| Liveness/attention (R19) | **S–M** | **Low** | Fully documented recipe with three exemplar domains. |
| Instrumentation (R20) | **M** | **Medium** | Cheap capture, but measure-sufficiency must be designed up front — unreconstructable later. |
| Release acceptance (R21) | **M** (process) | **Medium** | Depends on everything; refusal demos map to already-specified enforcement points. |

**Overall: XL (multi-phase program), High risk concentrated in the spec core + enforcement subsystems, not in the integrations** — the integration surfaces (CLI, events, UI primitives, workflow schema) are unusually well-prepared.

---

## 5. Constraints (from existing architecture)

1. **Shared `command-center.db` across branches/worktrees**: this branch will add many tables; other branches' builds read-quarantine unparseable rows, and additive-column races can break `next build`. Schema-floor DDL must be additive `IF NOT EXISTS`; breaking shapes need `KNOWN_SCHEMA_VERSION` discipline. Worktree-neutral state (R2.13) is automatic — the DB is already global — but that same sharing is the migration hazard.
2. **One state manager**: all persistence through state-store repos + write queue; no second store for spec content (bears on storage option 3.1 — file-based authored content would fight R2.13/R2.14 and the repo pattern).
3. **Events**: publish only through `publication.ts`; strict envelope schemas drop unknown fields (known gotcha) — spec event schemas must be authored with the envelope in mind.
4. **Workflow generality**: the three R17.5 capabilities must carry no SDD special-casing (standing product constraint and adjacent-expectations text).
5. **Seam ratchet**: new cross-boundary touchpoints (merge gate, definition edits, publication) must pass `bun run seams:check` without raising ceilings.
6. **UI**: design system wins over the prototype where they diverge; `StatusChip` for phase pills; no new global CSS; Storybook-free unit tests.
7. **CLI**: help-registry SSOT + contract tests + SKILL.md regeneration are mandatory for the new family; tier misuse is review-blocking.
8. **No Kiro migration**: `.kiro/specs/` untouched — no import path to design for, but also no fallback (R21.1 forbids it during acceptance).

---

## 6. Research Needed (carry into design phase)

1. **Authored-content storage model** vs the six invariants (§3.1 — the explicitly deferred decision): element-tree schema, revision snapshot representation, canonical export projection, verify algorithm.
2. **Tamper-evidence mechanism** (R2.5): per-revision content hash vs hash-chained records vs signed export; what "detectable and surfaced" means operationally.
3. **Element-identity + change classification**: how unchanged/modified/removed is computed at propose (structural diff keyed on element ids), and how requirement-modification subsumes nested criterion edits (R10.6).
4. **Comment re-anchoring** across revisions: relocation algorithm using anchor quote/prefix/suffix + element identity; explicit stale/orphaned presentation (R8.6).
5. **Optimistic-concurrency shape** (R7): per-element version counters vs revision-scoped etags; typed conflict payload carrying current content; interaction with the write queue.
6. **Delivery-gate seam placement** (§3.6) and refusal semantics inside the merge machine's fix/halt loops.
7. **Evidence freshness mechanics** (R13.6–13.10): pure-rebase identical-tree detection (relevant-tree hashing), captured-surface identity for screenshots/sign-offs, resolvability checks per evidence kind.
8. **Auto-attachment mapping** (R13.5): how lane commits / validator verdicts / test results discover their target criteria — presumably via the compiler's context→criteria provenance links; confirm the event payloads carry enough.
9. **Human-actor recording** (R6.7): what identifies "the human" on UI-originated mutations (single-operator today; record shape should not fabricate an agent).
10. **Drill-in picker UX** in Tiptap suggestion plumbing (`#slug/` continuing the query below a selected spec) — feasibility of two-stage suggestion within one extension.
11. **§6.1 measure sufficiency**: enumerate the exact event set each of the four measures needs; where spec events are durably retained (append-only spec-events table mirroring `graph_workflow_events`); how measure definitions are frozen (R20.4).
12. **Deep-link + scroll-to-element** routing scheme for Spec Studio (`/projects/[name]/specs/[slug]#R3.2`?) and alias-preserving resolution after rename (R1.6).
13. **Bare-handle context resolution** (R1.3): which contexts count as unambiguous (conversation with one referenced spec, lane with pinned spec, Studio page).
14. **One-active-execution key** (R16.2): per-spec active-execution constraint including Definition-review-counts-as-active, alongside the existing per-session constraint.

---

## 7. Recommendation Summary for Design Phase

- **Macro**: Hybrid — new `src/lib/specs/` domain (tickets as the structural exemplar) + four general subsystem extensions (reference registry + unified picker; three workflow definition capabilities; merge-gate evaluator seam; provenance link table). Sequence the workflow capabilities and reference registry early — they are independently shippable and de-risk the integrations.
- **Storage**: argue §3.1 Option C (structured spine with per-element prose bodies, immutable hash-stamped revision snapshots); explicitly reject document-primary against R2.14/R7.
- **Enforcement**: concentrate design attention on the three High-risk enforcement subsystems (approvals/policy, evidence/proof, delivery gate) — they carry the product thesis; everything else follows established recipes.
- **Instrumentation**: treat R20 as a first-class design section (event catalog + retention + measure definitions), not an afterthought — day-one capture is a hard requirement.

---

# Part II — Design-Phase Research Log (2026-07-18)

Six parallel deep-dive investigations resolving the §6 "Research Needed" items, plus the authoritative product-design read (rev 5) and charter. Findings condensed; each entry ends with the design implication.

### 8.1 Delivery-gate seam (RN6, §3.6)

- **Context**: R18 needs an evaluator reading spec (revision, scope) criteria interposed in merge machinery.
- **Findings**: Merge machine (`src/lib/workflows/merge/machine.ts`) is a linear pipeline: committing → merging → conflict resolution → validating (fix loop, `validation-fix/states.ts`) → preparing (squash to parked ref `refs/cc-merges/{jobId}`, capture `preparedSha` + `expectedTargetSha`) → publishing (CAS `git update-ref`) → terminal. Graph joins invoke it through `join-runner.ts` → `graph-merge-runner.ts`; `executionId` is available in join-runner scope but **not passed** into `MergeInput` today. The prepared candidate SHA is stable and hashable pre-CAS; commit-ancestry checks (`git merge-base --is-ancestor` vs `preparedSha`) are feasible. Same machine serves user-driven Smart Merge (no execution context).
- **Implication**: interpose as a new machine phase after the validation fix loop settles and before publish, behind an injected port (`DeliveryGateEvaluator` in merge domain; specs provides the adapter at composition). `executionId?` added to `MergeInput`, plumbed from join-runner; gate no-ops when absent. Refusal = typed terminal state + halt-reason event, before CAS so the parked ref stays intact. Candidate access satisfies R13.9/13.11 mechanics.

### 8.2 Workflow definition capabilities (RN, §3.5) + evidence payloads (RN8)

- **Findings**: `definition-schemas.ts` — `WorkflowDefinitionRecord` already carries an auto-incremented `revision`; contexts carry `acceptanceCriteria` (free text). Definition-level approval has a natural gate in `workflow-manager.ts start()` (after prerequisite validation, before machine init); the context-level `approval-gate.ts` precedent gives the record shape (atomic first-decision-wins, waiting loop polls ~1s and resumes). `definition-edits.ts` `applyOperation()` is the enforcement point for locked regions (fail one op → batch atomically refused); `runtime-edits.ts` and `storage.ts` replace are bypass routes needing the same guard. Evidence payloads: `GraphWorkflowValidationResultEvent` carries `contextId` + pass/summary/issues/reviewArtifact; lane `commitSnapshots[]` carry `{contextId, sha, committedAt}`; **test results are not structured events** (they arrive inside validator verdicts); task completion state is on `execution.taskStates`. `graph_workflow_events` supports incremental reads (`WHERE execution_id ORDER BY id`).
- **Implication**: all three capabilities land as general, schema-level additions (opaque `origin`/`sourceLink` strings — no spec imports); contextId is sufficient routing for evidence auto-attachment given a compiler-produced context→criteria origin map; ingestion can be pull-based and idempotent keyed by source event id.

### 8.3 Reference/chip plumbing (RN10, §3.2)

- **Findings**: exactly five touchpoints per type (node type, suggestion extension + popup, serializer case, parser + segmenter, paste handler). Today conversation mentions trigger on `#` and tickets on `!` — two Suggestion plugin instances with distinct PluginKeys; two extensions cannot share one trigger char, so R5.1 forces a single unified extension regardless. Drill-in is feasible in one extension: `SuggestionProps.query` carries the full text after `#`; the `items()` provider re-runs per keystroke and can switch item sets when the query contains `/` (stage 2 = element search within the matched spec). Suggestion data comes from client query hooks with client-side filter/score functions (`filterAndScoreTickets` et al.). Transcript chips are static link chips today (no hover/peek anywhere); `radix-ui@^1.6.2` (unified package) provides HoverCard. Paste-to-chip flows through `segmentTextByRefs()`/`ref-parser.ts` discriminated segments.
- **Implication**: registry-first refactor is the honest shape (entry = node name, trigger membership, XML tag + attrs schema, buildXml, parse, chip components, picker source); migrate conversation+ticket onto it, keep `!` as a ticket-only shortcut for continuity; hover/peek built on Radix HoverCard fed by a spec summary query (R5.6 mandates it — not deferrable).

### 8.4 Persistence recipe, counters, immutability, atomicity (RN1/RN2/RN5 groundwork)

- **Findings**: schema floor = `SCHEMA_DDL` in `state-db.ts` (idempotent, every open) + `ADDITIVE_COLUMNS` back-fills (with the multi-worker duplicate-column race handling); Umzug migrations only for data moves; breaking shapes bump `KNOWN_SCHEMA_VERSION`. Counter precedent: `ticket_counters` uses a single atomic `INSERT … ON CONFLICT … DO UPDATE … RETURNING` inside the write queue — race-safe, per-key sequences, deliberately no FK so deleted keys never reuse numbers. `session_alignment_versions` shows immutable-version-with-`content_hash` convention (immutability by service discipline, hash via `stableStringify`). `graph_workflow_events` is the append-only log precedent (AUTOINCREMENT id = order, never pruned). **Multi-table atomicity is available**: better-sqlite3 `db.transaction()` inside `withWriteQueue` — a revision snapshot spanning many rows commits atomically. **Optimistic concurrency: confirmed absent codebase-wide** (only client-side optimistic UI); version-checked writes are new ground. Contract tests: `createPersistenceFixture()` + `assertRoundTripDurability` with field policies.
- **Implication**: the spec domain can follow the tickets recipe wholesale; per-element CAS is implementable as `UPDATE … WHERE element_version = ?` + changes-count check inside the write-queue transaction; full row-set revision snapshots are atomically writable; all new tables are floor-DDL additive (no version bump).

### 8.5 Events, attention, notifications, ticket links (RN11 groundwork, §3.3)

- **Findings**: the recipe is complete and exemplified by tickets: strict `.strict()` domain event schema → `SSEEvent` union in `src/lib/api/sse-events.ts` → `publishEvent`/`publishEventBestEffort` → client `addSseListener` reactions → pure `sse-reducer.ts` + `pending-overlay.ts` reconciliation. Active Work/Needs You: `active-work-adapters.ts` adapts domain rows to `ActiveWorkItem` (`needsAction` for gates) and `AttentionItem`; notifications = repo row + `notification-created` event + settings-gated push triggers (`PushNotificationConfig.triggers`). Ticket links: `ticket_attachments` is a five-kind snapshot-oriented union; `ticket_sessions` is the dedicated relation-table precedent; the compaction attachment (`live_compaction` + `sourceAvailable` + `readCommands`) is the **only** live read-through precedent. Durable instrumentation pattern confirmed: graph-workflow mutators return `{state, events[]}` and the repository persists state + appends events **in one write-queue critical section**, then publishes SSE.
- **Implication**: spec events follow the same two-surface pattern (durable `spec_events` append in-transaction + SSE publish after commit); read-through ticket display is a render-time query through a link row (never a write to ticket fields); notification types and adapter additions are bounded, low-risk edits.

### 8.6 UI foundations (RN4/RN12 groundwork)

- **Findings**: annotation stack (`AnnotatedMarkdown` + recogito boundary + `CommentCard`/`CommentPopover`/`CommentGutterPin`) is production-ready and reusable as-is at the component level; anchors are block-scoped `{sectionId, line, charStart, charEnd, quote, prefix, suffix, docRevision}` with the `_setAnnotatorBoundaryForTesting` jsdom hatch. `document-comments` is session-scoped, flat (no threads), `pending|sent` lifecycle — wrong shape for spec review; a new project-scoped threaded model is cleaner than generalizing. Navigation: tickets are **top-level routes** (`/tickets`, `/tickets/[projectName]/[number]`) with project filtering — the "navigation peer" precedent; cockpit tabs are ephemeral Zustand (no URLs), unsuitable for R1.5 deep links. xyflow `AutoLayout` + custom node/edge types are directly reusable for the traceability graph. Diff precedent is the unified `DiffPanel` (code-oriented; semantic change list is new composition). Design bundle: `claude-design/spec-driven-development-ui/` (primary `SDD Prototype.dc.html`, 14 screens) is the interaction reference; CC design system wins visuals.
- **Implication**: Spec Studio = new top-level routes mirroring tickets; reuse annotation components over a new `spec_comments` model with pure re-anchoring; traceability graph = xyflow with new node types; semantic change list is the main net-new UI composition.

---

# Part III — Design Decisions (synthesis outcomes)

Synthesis lenses applied: **generalization** (reference registry; provenance link table spanning all five object kinds; one transition-predicate module; one projection module; three workflow capabilities kept general), **build-vs-adopt** (adopt every existing house pattern — state-store recipe, cctl contract, publication/SSE recipe, annotation stack, xyflow, Radix; build only what has no precedent: CAS writes, revision diff, policy engine, evidence/proof/freshness, compiler, export/verify), **simplification** (no stored phase/status; no sync jobs; no new storage technology; no new dependencies; comments as a new small model instead of generalizing document-comments; scope validity = one predicate rather than a "valid unit" DSL).

### Decision D1: Authored-content storage — structured element spine with per-element prose bodies (gap-analysis Option C)
- **Alternatives**: (A) fully structured rows only; (B) document-primary markdown + derived index; (C) hybrid spine.
- **Selected**: C, concretely: `spec_elements` owns identity (stable across revisions); `spec_element_versions` holds per-revision content rows keyed `(revision_id, element_id)` with kind-discriminated JSON payloads (prose-bearing elements store markdown bodies); a revision is a **full row-set snapshot** — creating a draft copies the base revision's rows (copy-on-write at revision granularity).
- **Rationale**: element-stable identity (2.6), element-granular CAS (7.1–7.4), semantic classification (10.5), and lint (R9) all operate on rows; immutability of approved revisions is row-set immutability; single authoritative representation is trivially true. Full snapshots beat deltas at this scale (single operator, hundreds of elements) and make classification a two-row-set comparison. **B is rejected**: element identity across text edits, element-granular optimistic writes, and change classification against a text blob would require a derived structural index — a silent second truth violating 2.15, and CAS on a blob violates 7.1.
- **Trade-offs**: more schema surface; export needs a deterministic projection (D9 makes that a feature, not a cost).

### Decision D2: Tamper evidence — canonical hash per frozen revision, recompute-on-verify
- **Selected**: at propose (freeze), compute SHA-256 over the canonical serialization (`stableStringify`) of the ordered element row-set; store on `spec_revisions.content_hash`. `cctl spec verify` and Spec Studio recompute and surface mismatches (banner + `spec-changed` event + exit-1 refusal). Approved-revision writes are additionally refused at the repo layer.
- **Rationale**: the operational envelope's threat is accidental/out-of-band mutation (shared DB across branches, manual edits, bugs) — detection + surfacing (2.5), not cryptographic non-repudiation. Hash chains/signatures rejected as envelope-inappropriate complexity.

### Decision D3: Concurrency — per-element integer versions with CAS, typed conflict
- **Selected**: `spec_element_versions.element_version` increments per draft write; every draft mutation carries the base version it read; the service performs compare-and-swap inside the write-queue transaction; mismatch returns `stale_element` carrying the current content + version (7.3). Element creation allocates identity via `spec_counters` (atomic upsert, ticket precedent); removal and reorder are CAS writes on the affected element rows. No locks, no LWW (7.4).
- **Follow-up**: contract-test the CAS under interleaved writers via the persistence fixture.

### Decision D4: Phase and statuses are derived projections; only Abandoned is stored
- **Selected**: pure `phase.ts` projection over (revisions, executions, abandonment): precedence per 3.6 (Executing primary; authoring facet secondary); Delivered evaluated per 3.7 against the current approved revision; requirement status (2.13) and task work status (2.12) are projections in the same module. `specs.abandoned_at/reason` is the only stored terminal fact (3.10).

### Decision D5: Gate policy — preset + sparse overrides on the spec; floor lives in the predicates
- **Selected**: `gate_policy` JSON on `specs` (`{preset, overrides?}`); pure `policy.ts` resolves the five dials (11.2 matrix per 11.3–11.5); the floor (11.6–11.9) is encoded in the transition predicates themselves so no policy value can express a floor violation. Preset switches / loosening are human-only Studio actions with a hard confirm (11.10) — `cctl spec` has no verb that changes policy.

### Decision D6: One transition-predicate module is the enforcement spine
- **Selected**: `transitions.ts` exposes typed predicates — `propose`, `signOffRevision`, `approveElement`, `startExecution`, `claimTaskComplete`, `evaluateDeliveryGate`, plus record-level guards (waiver grant, disposition set) — each returning `{ok}` or `{refused: {code, unmetConditions/findings, instruction}}`. Route handlers, `cctl spec`, and the merge-gate adapter all call the same predicates (6.1, 6.5); UI panels render the same finding lists (9.10).

### Decision D7: Evidence/proof subsystem — append-only, criterion-keyed, resolvability-checked; pull-based ingestion
- **Selected**: `spec_evidence` (append-only, typed refs + producer + execution + evaluated content state), `spec_proof_verdicts` (distinct records; evidence ≠ proof, 13.4), `spec_waivers`, `spec_criterion_dispositions`, `spec_task_claims`. Machine evidence kinds resolve server-side at record time (commit → git object in session worktree; validator verdict → `graph_workflow_events` row; test run → validator verdict or lane task event; screenshot → content-store object); unresolvable refs are refused like gate violations (13.2). Auto-attachment (13.7) = `evidence-ingest.ts`, an idempotent pull materializer over `graph_workflow_events` (keyed by source event id, routed contextId → criteria via the compiled origin map), invoked on evidence reads, claims, execution completion, and the delivery gate — no workflow-domain special-casing, no in-process bus.
- **Freshness (13.8–13.13)**: every evidence record stores `evaluated_state = {commitSha?, relevantPaths[], relevantTreeHash, surfaceId?}`; rules per kind: commit/diff valid iff ancestor of the merge candidate; deterministic verdicts valid iff relevant tree unchanged (pure-rebase case) else stale pending rerun (pre-merge validation rerun is the existing machinery); non-deterministic evidence stales when its captured surface's relevant tree changes; abandoned-run evidence is retained immutable and only counts when a later verdict re-establishes applicability against the new candidate.

### Decision D8: Revision diff/classification is a first-class pure module
- **Selected**: `revision-diff.ts` compares two revisions' element row-sets by element id → added/removed/modified (payload-hash inequality); a requirement is "modified" if its own payload or any nested criterion changed (10.6). Output drives the semantic change list (8.4), approval carry-forward/stale/closed at propose (10.5), plan-approval staleness (10.7), and the rework instrumentation payloads (20.1).

### Decision D9: Export/verify — canonical markdown + manifest projection (invariant 6 as behavior)
- **Selected**: `cctl spec export` renders a deterministic bundle: one canonical markdown document per revision (prose-first, handle-annotated) + `manifest.json` (element tree, hashes, approvals/admissions summary); `cctl spec verify` recomputes hashes from server state (and optionally against an exported bundle) and reports mismatches (6.8). This is the Git-projectable authored layer from the collaboration leaning — produced on demand, never synchronized back (no second truth).

### Decision D10: Compiler — pure spec→workflow-definition transform
- **Selected**: `compiler.ts` maps approved plan + validated scope → standard definition: tasks → contexts (dependency-chain grouping, 1:1 default), dependencies → edges, criteria → context `acceptanceCriteria` + validator briefs, per-lane narrow context packs; sets `origin` (spec/revision/task/criterion ids as opaque URIs), `lockedRegions` over contract-derived content, `approvalRequired: true`. Definition review/editing stays in the existing workflow surface (17.2).

### Decision D11: Three workflow capabilities land general (17.5)
- **Selected**: (1) `approvalRequired` + definition approval state, enforced in `workflow-manager.start()` before machine init, with approval recording mirroring `approval-gate.ts` mechanics; (2) optional opaque `origin` on definitions and contexts; (3) `lockedRegions` (field-path addressed + `sourceLink` + reason) enforced in `definition-edits.applyOperation` (atomic batch refusal with `region-locked` + amend-at-source instruction), in `runtime-edits` pre-mutation, and guarded on `storage` replace. No spec imports anywhere in the workflow domain.

### Decision D12: Delivery gate — merge-machine port, evaluated per candidate on every entry into publishing
- **Selected**: merge domain defines `DeliveryGateEvaluator` port invoked on every entry into publishing, keyed to the candidate being published (`preparedSha` — produced by the preparing actor; CAS re-prepares are re-gated); `MergeInput.executionId?` plumbed from `join-runner` at dispatch **and persisted on the merge job record**, so a parked ready-to-land candidate landed later from the session merge UI is gated identically; refusal → typed terminal state `deliveryGateFailed` + halt-reason/event listing unmet criteria (18.4), pre-CAS with the parked ref preserved. The spec-side adapter reads pinned (revision, scope) dispositions + proof verdicts + freshness — never the workflow definition (18.1). Gate no-ops for merges with no linked execution (non-spec merges unaffected). Rationale and alternatives (pre-merge-start check loses candidate-tree access; post-CAS is too late) per §8.1.
- **Refined 2026-07-18** (design validation): original "before preparing/publishing" placement was impossible (the evaluator consumes `preparedSha`, which preparing produces) and in-memory-only executionId left the persisted-job land path ungated — per-candidate evaluation + job-record persistence close both.
- **Refined 2026-07-18 round 2**: the validating phase persists a spec-agnostic candidate-validation fact on the merge job so the gate can credit 13.10 reruns to criteria (gate-side verdict issuance via EvidenceService, idempotent by `validationRef`); port input carries `workflowExecutionId` + optional `candidateValidation`; Delivered lands through idempotent `markDelivered(specExecutionId, mergeHash)` with read-path reconciliation.

### Decision D13: Reference system — registry-first, unified `#`, `!` retained
- **Selected**: `reference-registry.ts` describing each type; one unified `#` Suggestion extension + grouped type-filterable popup with `/`-triggered drill-in; conversation/ticket types migrated onto the registry (parity-preserving); `!` ticket shortcut retained (no regression; unification requirement is about `#`). Four new tags `<spec-ref/>`, `<requirement-ref/>`, `<decision-ref/>`, `<task-ref/>` with embedded `cctl spec` read commands (address-not-dump, 5.10), `revision` attr recorded at insert (5.9); chips resolve live state via summary queries; hover/peek via Radix HoverCard.

### Decision D14: Spec Studio — top-level routes on the tickets precedent; new threaded comments model
- **Selected**: routes `/specs` (list, project-filterable) and `/specs/[projectName]/[slug]` (detail; `?el=R3.2` deep-link + scroll; alias-aware slug resolution) — real URLs because R1.5 demands deep links (cockpit ephemeral tabs rejected). Annotation components reused; `spec_comments` is a new project-scoped model with threads, blocking flag, resolution state, element-anchored ranges + original revision; `reanchor.ts` relocates a thread only on unambiguous quote match within the same element body, else presents stale/orphaned (8.6). V1 Studio never edits content (8.3).

### Decision D15: Events — durable `spec_events` + typed SSE catalog, two-surface single-transaction pattern
- **Selected**: every mutation appends typed rows to `spec_events` in the same write-queue transaction (graph-workflow mutator pattern) and publishes SSE after commit. SSE catalog (stable names): `spec-changed`, `spec-revision-changed`, `spec-approval-changed`, `spec-execution-changed`, `spec-evidence-changed`, `spec-attention-changed` — strict schemas, kind discriminators inside. Active Work adapter (executions in definition-review/running), Needs You (pending gates with deep links), notification types with settings triggers (10.9, 19.3). `spec_events` is the §6.1 measure substrate (20.1–20.3); measure definitions are code (`measures.ts`) with a version string surfaced via `cctl spec measures`, frozen by recording that version in a `spec_events` row at pilot start (20.4).

### Decision D16: Naming — working vocabulary adopted as final for V1
- **Selected**: "spec", "Spec Studio", `cctl spec` become the shipped names (charter defers naming to this phase; the vocabulary has survived five revisions and all surfaces already use it). Route segment `/specs`, domain `src/lib/specs/`.

### Decision D17: Bare-handle resolution contexts (1.3) are explicit, not inferred
- **Selected**: bare handles resolve only where a single spec is structurally pinned: inside Spec Studio's spec detail surface, in `cctl spec` invocations whose arguments already name the slug (`cctl spec get native-sdd/R3` allows `R3` in secondary positions), and in picker drill-in after a spec is selected. No conversational inference server-side.

### Decision D18: Human-actor recording (6.7)
- **Selected**: every mutation records `actor = {kind: "agent", conversationId, backend?} | {kind: "human"}`; agent identity from the established cctl env injection; UI routes stamp `{kind: "human"}` (single-operator deployment — no fabricated agent/conversation).

## Risks & Mitigations (design-phase)

- **CAS-under-write-queue subtleties** (first optimistic-concurrency implementation) — mitigate with persistence-fixture contract tests simulating interleaved writers; CAS check and write in one transaction.
- **Delivery-gate seam regressions in merge machine** (high stakes, small code) — port is optional input; gate absent ⇒ machine behavior byte-identical; add machine-level tests for both branches and a live refusal demonstration (21.3).
- **Reference-registry migration breaking existing chips** — parity tests over serializer/parser round-trips for conversation/ticket/message refs before adding spec types.
- **Definition `lockedRegions` bypass via replace/runtime edits** — enforce at all three seams (definition-edits, runtime-edits, storage replace); add tests per seam.
- **Evidence ingestion duplication/ordering** — idempotency key = source `graph_workflow_events` row id; ingestion is a pure fold, re-runnable.
- **Shared-DB additive discipline** — all-new tables via floor DDL, no `KNOWN_SCHEMA_VERSION` bump; `bun run build` smoke for multi-worker races.
- **Scope creep into workflow domain** — the three capabilities reviewed against "no SDD special-casing" (charter constraint); origin/sourceLink stay opaque strings.

## Design Validation Round (2026-07-18)

Collab design review (`/kiro-validate-design` via conversation 9c925307, kiro criteria + software-design-philosophy lens): **NO-GO as written → all six fixes applied same day, design.md-only** (no scope, dependency, or D1–D18 decision changes; software-design score 8/10 as written).

1. **Critical — impossible cross-store transaction at execution start**: fixed as a definition-first idempotent two-step protocol; SQLite transaction is the authoritative commit point; crash leaves an inert orphan found by origin key (ExecutionService).
2. **Critical — request-changes returned Proposed → Draft** (contradicted 3.3/8.5, destroyed the reviewed snapshot D2/8.6/10.5/20.1 depend on): fixed — request-changes withdraws the proposed revision (content + hash immutable) and opens a new draft `based_on` it.
3. **Critical — delivery-gate placement + land-path bypass**: fixed per refined D12 above.
4. Stale-chip basis (5.9): content-changed-since-observed-revision via `payload_hash` lineage, not revision-number comparison.
5. Validation-strategy satisfaction contract (13.4–13.6): ≥1 resolvable fresh evidence record per required kind; fixed verdict origins (ingestion / UI routes only — no CLI verdict verb); `note` bounds validator judgment.
6. Phase-projection precedence made explicit (authoring states outrank Delivered/Approved, symmetric per 3.9) with composite `{primary, authoringFacet?}` return shape mandated at every phase render site.

Non-blocking polish also applied: human-act discriminator named (transport identity: cctl bearer/env = agent, browser session on UI routes = human); read-path evidence ingestion declared best-effort; `spec_counters` scope `S` dropped (sections carry no handle per R1.2).

**Round 2** (conversation 80d2df5d, targeted re-validation): all six round-1 fixes verified in place against design text + code reality; **NO-GO on three interface-contract gaps → F1–F4 applied same day, design.md-only** (zero new tables/dependencies/surfaces/features):

1. **F1 — Transition ownership table** (new subsection after State Machines): every revision/execution transition names initiator, authorization, predicate, transaction, idempotency. Key settlements: propose **absorbs the policy-admitted sign-off** when every propose-time dial (requirements/design/plan) is Notify/Off — admissions + sign-off admission recorded atomically, zero approval rows, 10.4 preconditions still checked (failure leaves the revision Proposed); any Gate dial ⇒ sign-off stays the human Studio action; no cctl sign-off verb either way. New verbs `cctl spec start --file <scope.json>` (schema-backed scope doc incl. 16.6 exclusion dispositions) and `cctl spec abandon --reason`. Disposition authority is per-value (in_scope=scope-derived; deferred=agent start intent; waived=by reference to human waiver; delivered_elsewhere=server-verified). Composition-injected idempotent `markRunning(workflowExecutionId)` / `markDelivered(specExecutionId, mergeHash)` with read-path reconciliation covering callback loss (publish-then-crash).
2. **F2 — Candidate-proof bridge**: merge validating phase persists a spec-agnostic candidate-validation fact `{validationRef, validatedSha, validatedTreeHash, commandIdentity, outcome}` on the merge job (rebuilt at land re-entry; the validating actor's output is currently void). Gate-side: identical relevant tree ⇒ 13.9 keeps proof; changed tree + applicable passing fact ⇒ adapter appends `test_run`/`validator_verdict` evidence resolving to the fact + issues fresh deterministic verdicts via EvidenceService, idempotent by `validationRef`. CAS re-prepare with changed tree refuses until a fresh dispatch re-validates — no mid-machine validation loop; refusal instruction names re-dispatch.
3. **F3 — Refusal envelope**: `unresolvable_evidence` + `invalid_scope` reclassified 422→409 (the shared classifier maps 400/422→exit 2; every server refusal now rides 409→exit 1); `src/cli/shared.ts` extended additively to carry server `instruction` + code-discriminated `details` (lint findings; stale-element current content+version), `unmetConditions`→`issues`; full matrix contract-tested. Shared-classifier completion, not a spec-only adapter.
4. **F4 — Precision**: id domains named at every cross-domain callback (`workflowExecutionId` passed by workflow/merge infra vs `specExecutionId` resolved via `spec_executions.workflow_execution_id`, unlinked ⇒ no-op); chip staleness compares the observed `payload_hash` against the element's hash in the latest revision containing it, **drafts included** (hash-restoring edit ⇒ fresh again).

## References

- `docs/design/native-sdd/01-product-design.md` (rev 5) — authoritative product semantics.
- `.cc/session-alignment/charter.md` — governing decisions, constraints, open items resolved here (storage, naming).
- `claude-design/spec-driven-development-ui/` — UI handoff bundle (14 screens); design system wins visuals.
- Steering: `structure.md`, `tech.md`, `product.md`, plus `cli.md`, `data-fetching-and-sse.md`, `workflows.md` (contract references for the integration seams).
