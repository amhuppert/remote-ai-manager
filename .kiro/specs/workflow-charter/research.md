# Gap Analysis: workflow-charter

Brownfield analysis for the Workflow Charter feature against the existing Graph Workflow engine (`src/lib/workflow-graph/`, `src/lib/workflows/`). Line references confirmed by codebase exploration. This informs design only — no implementation decisions are final here.

## 1. Summary

- **Mostly additive.** Every requirement maps to an established seam (definition schema, prompt builders, resolved-context passthrough, execution-logger lifecycle event, SSE event bus, shared-documents/artifact registry, round-trip durability contract). No new architectural primitive is needed.
- **Charter is NOT a config-cascade field.** Per the resolved decisions, the charter is a top-level field on `workflowSemanticDefinitionSchema` (semantic content), attached to every resolved context directly — *not* merged through `resolveWorkflowConfig`'s global→workflow→context cascade. The exploration's suggestion to cascade it is explicitly out of bounds.
- **Conflict recording reuses the existing `summary` strings.** The validator records an AC-vs-source conflict in its existing `summary` field, and the implementer cites the governing source in the existing `complete_task` `summary`. We do **not** add structured verdict fields or a `recordCharterConflict` tool — those belong to `validator-trust`.
- **Two persistence paths, two durability contracts.** The canonical charter rides the workflow **definition** (workflow storage) and the engine mirrors it to a registered shared-document file that rides the **execution** (sessions-repo). Both round-trip contracts need extending.
- **Largest unknown:** whether an execution snapshots the resolved definition or references it by `definitionId`+`definitionRevision` (resolve-on-read). This decides where prompts read the charter and what must persist on the execution. Flagged Research-Needed.

## 2. Current-state integration map (confirmed seams)

| # | Area | File | Key type/function | Seam |
|---|------|------|-------------------|------|
| 1 | Definition schema | `src/lib/workflows/schemas.ts` | `workflowSemanticDefinitionSchema` (293–304); `schemaVersion` defaults to 1 (294) | Add top-level optional `charter?` after `schemaVersion`. **Not** in `workflowConfigOverrideSchema`. |
| 2 | Resolved context | `schemas.ts` | `graphWorkflowResolvedContextSchema` (306–325) | Add `charter?` so both prompt builders receive it. |
| 3 | Shared docs / artifacts | `shared-documents.ts`; `GraphWorkflowSharedDocumentEntry` (schemas.ts 388–399); `primitives/artifact-registry.ts` (`ARTIFACT_KINDS`, `.cc/graph-workflow-docs`) | Entry shape `{id, relativePath, description, readWhen, …}` — **no `kind` today**. Register the mirrored charter file here. |
| 4 | Implementer prompt | `iteration-prompt.ts` | `buildIterationPrompt` (156–277), shared-docs section (266–274); **`buildFollowUpPrompt` (≈288) takes no charter today** | Insert charter digest at the top; add charter to `BuildIterationPromptInput` and to follow-up input. |
| 5 | Validator prompt | `validator-runner.ts` | `buildContextValidationPrompt` (79–125), guidance (96–100), output `summary`+`issues` schema (`VALIDATOR_OUTPUT_SCHEMA` 36–56) | Inject charter; amend guidance text. Conflict goes in existing `summary` — **no schema change**. |
| 6 | complete_task | `tool-server.ts` | `completeTaskSchema` (25–40) `summary` (string, required); handler (184–220) → `context.completeTask(slug, summary)` | Implementer cites governing source in the existing `summary`; no new tool. |
| 7 | Execution logger | `execution-logger.ts` | `ExecutionLogger.lifecycle(event, data)` (107); JSONL channels incl. `lifecycle.jsonl` | Emit `charter.registered` / `charter.updated`. |
| 8 | SSE broadcast | `execution-events.ts` (`defaultBroadcast` 33–35 → `publishSessionStatus`); `GraphWorkflowSSEEvent` union (schemas.ts ≈1088) incl. `graphWorkflowSharedDocumentsUpdatedEventSchema` | Add a charter SSE event, or piggyback the shared-documents-updated event for the file + a dedicated lifecycle event for audit. |
| 9 | Config / resolution | `resolve-config.ts` | `resolveWorkflowConfig` (76–95), `resolveContext` (111–150) | Attach the workflow-global charter to every resolved context **by passthrough, not cascade merge**. |
| 10 | Create/replace | `planner-tools.ts` | `createWorkflowSchema`/`replaceWorkflowSchema` (130–201), `inflateToSemanticDefinition` (213–267), handlers (327–393); MCP tools `create_graph_workflow`/`replace_graph_workflow` | Require charter on the **input** schema; validate; reject if absent (new defs). |
| 11 | Execution seed | `execution-repository.ts` | `createExecutionFromSeed` (48–89), seeds `sharedDocuments: []` (81); `GraphWorkflowExecution` (schemas.ts 1162–1207) | Propagate charter at seed: resolve from definition, write mirrored file, register shared-doc entry. |
| 12 | Durability | `shared/testing/round-trip-durability.ts` (`assertRoundTripDurability`); `state-store/sessions-repo.contract.test.ts` (`makeFullSession` 52–94, already round-trips `graphWorkflowExecution`) | Extend the execution fixture for the charter-derived shared-doc; extend the **workflow-definition** storage contract for the `charter` field. |
| 13 | DI / tests | `workflow-graph` package | Factory + default-deps pattern (`createGraphWorkflowSharedDocumentRegistryService` shared-documents.ts 48; `createExecutionLogger`; `createWorkflowStorageService` storage.ts 82). No XState `.provide()` here. | New charter code uses `createX(deps)` + `{...defaultDeps, ...deps}`; never `vi.mock` internal modules. |

## 3. Requirement → asset map (gap tags: Missing / Constraint / Research-Needed)

- **R1 content model** — *Missing*: new Zod schemas for the charter envelope + `sourceOfTruth` entry (`rank, id, label, type, locator, description, appliesTo, accessPolicy`). Asset: `schemas.ts` `z.infer` convention.
- **R1.4 reject malformed** — *Missing*: Zod `superRefine` for rank uniqueness/contiguity + required-field presence; create-handler surfaces the error (planner-tools error path 334–336/365–367).
- **R1.5 workflow-global** — *Constraint*: deliberately bypass the cascade; one charter attached to all resolved contexts; no per-context `charterRef`.
- **R2 required-before-exec (new defs)** — *Partial asset*: create/replace handlers exist; add presence check on the **input** schema only.
- **R2.3 no mid-run change** — *Constraint*: ensure no tool path (e.g. `upsert_shared_document`) can mutate the charter during execution.
- **R2.4 / R3 new-only + compat** — *Constraint*: charter **optional** on the persisted definition & execution schemas so existing records parse; **required** on the create/replace input schema. No migration.
- **R4 presentation** — *Missing*: charter section in `buildIterationPrompt`, `buildFollowUpPrompt`, and `buildContextValidationPrompt`; charter on the resolved context. `buildFollowUpPrompt` has no charter input today (clear gap).
- **R4.3 digest + on-demand full** — *Missing*: digest generator + mirrored charter file registered via the shared-documents/artifact registry (`.cc/graph-workflow-docs`).
- **R4.5 same content both roles** — *Missing*: feed both builders the identical resolved charter.
- **R5 conflict resolution** — *Missing prompt text* only: amend validator guidance (lines 96–100) and implementer guidance; **reuse existing `summary` fields**; *Constraint*: no structured verdict / ESCALATE (that is `validator-trust`).
- **R6 external sources** — *Missing*: `accessPolicy` semantics + an engine rule that never auto-reads/writes/validates an `external-readonly` locator; *Constraint*: worktree isolation.
- **R7 observability** — *Partial asset*: `lifecycle()` + SSE bus exist; add charter events + (optionally) a dedicated charter SSE event; make the governing charter identifiable on the execution record.

## 4. Implementation approach options

**Option A — Extend existing components (recommended).**
Add the `charter` field to the existing definition schema, attach it to the resolved context in `resolveContext`, render a section in the existing prompt builders, mirror it through the existing shared-documents registry, and emit through the existing logger + SSE bus. No new module beyond a small charter schema file + a digest helper.
- ✅ Follows every established pattern; smallest surface; reuses persistence + durability harness.
- ✅ Keeps the engine's "fresh context per execution context" property intact.
- ❌ Touches several files (two prompt builders, resolve-config, planner-tools, execution-repository, schemas) — needs disciplined sequencing.

**Option B — New charter subsystem (a `charter/` module owning schema, digest, resolution, file mirroring).**
- ✅ Clean single-responsibility home; easy to unit-test the digest + validation in isolation.
- ✅ Natural seam for `validator-trust`/`spec-lint` to import later.
- ❌ Still must call into the same prompt/seed/log seams as Option A — the "new module" doesn't remove the integration edits, it just relocates the logic.

**Option C — Hybrid (recommended in practice).** A small new `charter/` module owns the *pure* logic (schema, `superRefine` validation, deterministic digest builder, accessPolicy rules) as testable pure functions; the integration edits (prompt sections, resolved-context passthrough, seed propagation, events) extend existing files and call into that module.
- ✅ Pure logic is directly unit-testable without mocking (matches the "extract pure functions" rule); integration stays thin.
- ✅ Gives downstream specs a clean import target.
- ❌ Slightly more upfront structure than Option A.

## 5. Effort & risk

- **Overall: M (3–7 days), Risk Low–Medium.** Additive extension of familiar patterns.
- Charter schema + validation + digest (pure): **S, Low**.
- Prompt injection across 3 builders incl. follow-up: **S–M, Low** (follow-up builder currently has no charter input).
- Resolved-context passthrough (no cascade): **S, Low**.
- Create/replace required-charter + parse-tolerant persisted schema: **S, Low–Medium** (the required-input vs optional-persisted split is the subtle part).
- Seed propagation + mirrored file registration: **M, Medium** (depends on the snapshot-vs-reference question below).
- Validator/implementer guidance change + behavioral fixture (R5, the floor/round reproduction): **M, Medium** — the only judgment-heavy, behavior-verifying piece.
- Logger + SSE events + durability contract extensions: **S, Low**.

## 6. Key design decisions to settle (carry into design)

1. **Execution ↔ definition coupling:** does the execution snapshot the resolved definition (charter rides the execution) or reference `definitionId`+`definitionRevision` and resolve-on-read? Decides what persists on the execution and where prompts read the charter.
2. **Mirrored-file representation:** add a `kind: "charter"` discriminator to `GraphWorkflowSharedDocumentEntry`, or register a plain shared-doc pointer the prompt builder locates by convention? (Resolved decision: "separate model + registered doc" — design picks the exact entry representation. A new persisted field on the entry means extending the sessions-repo durability contract.)
3. **Digest generation:** deterministic from the structured fields (mission + hierarchy + non-goals) vs author-supplied. Resolved lean: deterministic where structured, author-supplied for markdown sections. Confirm the token budget for the top-of-prompt digest.
4. **Charter SSE event:** dedicated `graph-workflow-charter-*` event vs piggyback on `sharedDocumentsUpdated` for the file + a lifecycle log event for audit. R7.4 ("governing charter identifiable per run") favors a dedicated/audit-grade event.
5. **`accessPolicy` enum + enforcement point:** where the "never auto-access external locators" rule is enforced (resolution time vs file-mirroring time vs prompt rendering).
6. **Required-vs-optional split:** charter required on `createWorkflowSchema`/`replaceWorkflowSchema`, optional on `workflowSemanticDefinitionSchema` and `GraphWorkflowExecution`, so existing records parse (the consistency point flagged in requirements review).

## 7. Research-Needed

- Confirm the **workflow-definition persistence path** (`storage.ts` / `createWorkflowStorageService`) and whether a round-trip durability contract exists for definitions; if so, extend it for `charter`; if not, design must add one (a new persisted field on a stored entity requires the durability backstop per project rules).
- Confirm the **snapshot-vs-reference** behavior in `createExecutionFromSeed` (line 57 `resolveWorkflowDefinition`) — see decision #1.
- Confirm whether **SDK prompt-caching** is engaged (affects only the *value* of top-of-prompt placement; placement itself is already decided regardless).
- Confirm the `upsert_shared_document` tool cannot be used to overwrite the registered charter file mid-run (R2.3 enforcement).

## 8. Scope guardrails (corrections applied to the raw exploration)

These keep design in-bounds with the resolved decisions:
- **No config-cascade for the charter** (it is semantic content, not an operational default).
- **No per-context `charterRef` / no per-context override** (charter is workflow-global).
- **No structured validator conflict field, no `recordCharterConflict` tool, no ESCALATE/appeal** — conflicts go in the existing `summary`; structured verdicts belong to `validator-trust`.
- **No `acknowledge_artifact` and no separate charter version field** — acknowledgment is deferred; a charter's version is the workflow-definition revision.
- **No migration / no retrofit** of existing, running, or resumed executions.

---

# Design Synthesis & Decisions (kiro-spec-design)

**Discovery scope**: Extension (light/integration-focused). No new external dependency; no web research required. The integration map above (gap analysis) served as the light-discovery output.

## Synthesis lenses

- **Generalization**: the only generalization kept is a defaulted `kind` discriminator on the shared-document entry, which future high-authority artifacts (e.g. frozen contracts) can reuse — interface generalized, implementation charter-only. No over-generalization toward the deferred acknowledgment mechanism.
- **Build vs. adopt**: adopt existing primitives throughout — Zod (schema), shared-documents/artifact registry (mirrored file), `execution-logger.lifecycle` + `execution-events.defaultBroadcast` (observability), the round-trip durability harness (persistence backstop), `node:crypto` sha256 (content hash). Nothing custom is built where a primitive exists.
- **Simplification**: removed four would-be moving parts — no stored digest (computed on read), no separate charter version field (use the definition revision + content hash), no structured validator conflict field (reuse the existing `summary`), no config-cascade routing and no per-context override. This is the smallest design satisfying all requirements.

## Decision: Execution ↔ definition coupling — snapshot onto the execution
- **Context**: prompts need the charter at runtime; the run must be immutable against later definition edits (2.4) and the governing charter must be identifiable per run (7.4).
- **Alternatives**: (A) snapshot the resolved charter onto `execution.charter` at seed; (B) resolve-on-read from `definitionId`+`definitionRevision` relying on revision-retention immutability.
- **Selected**: (A) snapshot. Self-contained, immutable per run, does not depend on unverified revision-retention semantics, and directly satisfies 2.4/7.4.
- **Trade-offs**: a small intentional duplication (charter on both definition and execution) and one new persisted field requiring a durability-contract extension — justified by the immutability requirement, not speculative.
- **Follow-up**: confirm `createExecutionFromSeed` exposes the seed definition's charter; extend the sessions-repo durability contract for `execution.charter`.

## Decision: Mirrored-file representation — defaulted `kind` discriminator
- **Context**: the full charter must be readable on demand and identifiable in the registry; the reserved-kind deliverable asks for a `kind: "charter"`.
- **Selected**: add `kind: z.enum(["shared","charter"]).default("shared")` to the shared-document entry; render the structured charter to `.cc/graph-workflow-docs/charter.md` and register it as `kind:"charter"`. The prompt builder surfaces the charter at the top and excludes the `kind:"charter"` entry from the generic Shared Documents list.
- **Trade-offs**: one new (defaulted) persisted field on the entry → durability-contract extension; default keeps existing entries valid (3.x).

## Decision: Digest is deterministic, computed on read; conflicts reuse `summary`
- **Context**: §1.1 of the report frames both "injected verbatim" and "digest + on demand"; the validator must record conflicts without the structured-verdict machinery owned by `validator-trust`.
- **Selected**: the renderer deterministically produces a budgeted digest from the structured charter at each prompt build (no stored digest, no LLM call); the full charter is the mirrored file. The validator records source-vs-AC conflicts in its existing `summary` string and the implementer cites the governing source in the existing `complete_task` summary — no schema change, no new tool.
- **Rationale**: token economy + keeps the slice strictly within its boundary against `validator-trust`.

## Decision: Required-input / optional-persisted split for compatibility
- **Context**: charter required for new workflows (2.1/2.2) but existing charter-less records must still load (3.1–3.3) with no migration.
- **Selected**: `charter` is **required** on the create/replace **input** schemas and rejected at accept time if absent/invalid (1.4, 2.2); it is **optional** on the persisted `workflowSemanticDefinitionSchema` and on `GraphWorkflowExecution`, so stored records parse unchanged.

## Risks & Mitigations
- Mid-run drift of `charter.md` via write tools — mitigated: governance derives from the immutable `execution.charter` snapshot, not the file (2.3).
- Charter feature accidentally activating for charter-less workflows — mitigated: every charter code path guards on `definition.charter` presence (3.1/3.2).
- Prompt-size growth — mitigated: only the budgeted digest is injected; full content stays in the file.
- Definition-storage durability for the new `charter` field — follow-up: confirm/extend the workflow-definition round-trip contract (`storage.ts`); add one if absent.

---

# Revision (design review): charter required + one-time purge migration

**Supersedes** the earlier "Required-input / optional-persisted split for compatibility" decision.

## Decision: Charter required everywhere; one-time migration deletes pre-charter records
- **Context**: operator directive during design review — make the charter a required schema field and delete all existing workflow definitions and executions via a one-time migration instead of tolerating charter-less records.
- **Selected**: `definition.charter` and `execution.charter` are **required** (not optional); the create/replace input and the persisted definition schema both require it (no input-vs-persisted split). A tracked one-time migration deletes all workflow definitions and nulls the embedded `graphWorkflowExecution` on every session.
- **Rationale**: removes the optional-field guards across seed/prompt/resolve and the dual-schema split; the engine never handles a charter-less workflow.
- **Trade-offs**: simpler runtime at the cost of a destructive, irreversible migration; loss of pre-charter run audit history.

## Risk: shared-database blast radius (confirmed — global delete)
- `command-center.db` is shared across all branches/worktrees/sessions (see memory: "Shared state DB across branches"). A delete migration removes workflow definitions + executions for **every** branch and session, not just this worktree.
- The existing read-boundary **quarantine** already prevents crashes on unparseable (charter-less) rows, so a non-destructive, branch-local alternative exists (rely on quarantine; do not delete). The destructive global delete is only required if the rows must be physically purged from the shared store.
- **Embedded-execution hazard**: executions live inside `SessionState`; requiring `charter` on the execution could quarantine whole sessions carrying a legacy execution unless the migration nulls those embedded executions first.
- **Follow-up**: (a) RESOLVED — operator confirmed (2026-06-14) that a global purge across all branches/sessions is intended and acceptable. Remaining implementation follow-ups: (b) the migration runner/path in the state store, and (c) that nulling embedded executions per session (not a table drop) is the correct mechanism.
