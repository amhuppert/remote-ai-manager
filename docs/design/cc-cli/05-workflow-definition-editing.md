# 05 — Targeted Workflow Definition Editing

Status: implemented (2026-07-07)

## Problem

The only way to revise a saved graph-workflow definition today is a full swap:
`cctl workflow get <id>` (entire record dumped into the agent's context) → edit the whole
plan.json → `cctl workflow replace <id> --file plan.json`. A realistic multi-context
definition is 15–30 KB (mostly task instructions, acceptance criteria, and charter prose),
so a one-line title fix costs the agent the full definition **twice** — once inbound, once
outbound — plus the risk of transcription drift on everything it didn't mean to touch.

Goals:

1. **Token-efficient targeted edits** — cost proportional to the change, not the definition.
2. **Full range of changes** — everything expressible in a plan.json is reachable via edits.
3. **Invariants never violated** — every edit lands behind the same accept-time validation
   gate as `create`/`replace`.
4. **Selective reads** — inspect one context/task/section without the full dump.
5. **Batched, atomic edits** — several operations in one call, all-or-nothing.

## Current state (what we build on)

- Definition shape: `WorkflowSemanticDefinition` (`src/lib/workflows/schemas.ts`) =
  `{ schemaVersion, workflowConfig, charter, parameters, prerequisites, executionContexts[], tasks[], edges[] }`,
  wrapped in `WorkflowDefinitionRecord` (`id`, `name`, `description`, `revision`, `definition`, `layout`).
- All accept-time invariants are centralized in `validateAuthoredDefinition`
  (`src/lib/workflow-graph/validation.ts`): structural graph checks (unique ids, known
  references, non-empty prose, per-context task-order uniqueness, DAG acyclicity), parameter
  declaration checks, `{{inputs.*}}` reference lint, prerequisite checks.
- `createWorkflowStorageService` (`src/lib/workflow-graph/storage.ts`) is the single
  read/write choke point; `create()`/`update()` already run `assertValidDefinition` and mint
  `revision`. Any edit path that persists through `update()` cannot land an invalid definition.
- Precedent for an operation vocabulary: the runtime-edits endpoint
  (`workflowRuntimeEditRequestSchema`: add/update/remove/reorder/move tasks) mutates a
  *running execution's* `workingDefinition`. This design targets the *saved definition*;
  the vocabularies are deliberately aligned (same verbs, same field names) but the surfaces
  stay separate — different lifecycles, different preconditions.

## Design overview

Two additions to the `cctl workflow` group:

1. **Selective reads** — `cctl workflow get <id>` grows section selectors, and its default
   output becomes a compact **outline** (structure + identifiers + prose sizes, no prose
   bodies). The outline is the agent's navigation map: everything needed to address an edit
   (context ids, task ids, orders, edge pairs, revision) in a few hundred tokens.
2. **Batch edit** — `cctl workflow edit <id> --file ops.json` applies an ordered list of
   domain operations atomically, validating the final definition with
   `validateAuthoredDefinition` before persisting via `storage.update()`.

Domain operations addressed by **stable ids** were chosen over generic JSON Patch: agents
would need array indices for JSON Patch paths (forcing a full read anyway, and fragile under
concurrent edits), and per-op semantic preconditions ("task exists", "context not empty")
produce far better errors than "path not found". This also matches the existing runtime-edit
vocabulary and the CLI's error contract (structured `issues[]` with locators).

## Read API

```
cctl workflow get <id>                  # outline (new default)
cctl workflow get <id> --full           # entire WorkflowDefinitionRecord (old behavior)
cctl workflow get <id> --context <ctx>  # one context (full prose + config) + its tasks (full instructions)
cctl workflow get <id> --task <task>    # one task, full instructions + metadata
cctl workflow get <id> --charter        # charter only
cctl workflow get <id> --config         # workflowConfig + per-context override blocks only
cctl workflow get <id> --params         # parameters + prerequisites
cctl workflow get <id> --tier global    # same selectors against a global template
```

One selector per invocation (repeat the command for more; keeps parsing and help simple).
Selectors are **CLI-side projections** over the existing `GET /workflows/[workflowId]`
response — no new read endpoints. Token efficiency is about what enters the agent's context,
not wire bytes; the CLI prints only the slice, and the `--json` envelope carries only the
slice.

Outline (text mode; `--json` carries the same data structured):

```
workflow 4f1d2797 "tailwind-stage-b1" rev 7
contexts (3):
  plan    "Plan the approach"   deps=-      tasks=2   [validator override]
  impl    "Implement"           deps=plan   tasks=3
  verify  "Verify"              deps=impl   tasks=1
tasks:
  plan   1 plan-survey  "Survey current CSS"      (612 chars)
         2 plan-write   "Write plan.md"           (488 chars)
  impl   1 impl-tokens  "Migrate tokens"          (1.4k chars)
  ...
charter: mission 214 chars · conventions 3 · sources 2
parameters: feature-name (string, required)
prerequisites: path:.kiro/steering/tech.md
config overrides: workflow=- · contexts: plan(contextValidator)
```

Prose fields show **sizes, not bodies** — the agent sees what exists and fetches only what
it intends to change. The outline always includes `revision` (needed for `expectedRevision`
below).

## Edit API

```
cctl workflow edit <id> --file ops.json [--dry-run] [--tier project|global]
```

`ops.json`:

```jsonc
{
  "expectedRevision": 7,
  "operations": [
    { "type": "update-task", "taskId": "impl-tokens", "instructions": "…new instructions…" },
    { "type": "add-context", "id": "docs", "title": "Document", "acceptanceCriteria": "…" },
    { "type": "add-task", "id": "docs-1", "contextId": "docs", "title": "…", "instructions": "…" },
    { "type": "add-edge", "sourceContextId": "impl", "targetContextId": "docs" }
  ]
}
```

Semantics:

- **Ordered** — operations apply sequentially against an in-memory copy; later ops see
  earlier results (add a context, then its tasks, then its edges — in one batch).
- **Atomic** — any per-op precondition failure or any post-batch validation error rejects
  the whole batch; nothing persists. This isn't just convenience: several legitimate
  multi-step restructures pass through intermediate states that full-definition validation
  would reject, so per-op persistence is not an option.
- **Validated** — after the last op, the full mutated definition runs
  `validateAuthoredDefinition` (identical gate to `create`/`replace`), then persists via
  `storage.update()` (which re-asserts). Invariants hold by construction.
- **Optimistic concurrency** — `expectedRevision` is required; if the stored revision differs,
  the server rejects with 409 / code `stale_workflow_definition` (payload includes
  `currentRevision`; hint points at `cctl workflow get <id>`). Every successful edit (and
  `create`) returns the new revision, so edit chains never need a re-read.
- **`--dry-run`** — full apply + validate, report the outcome, persist nothing. For
  pre-flighting risky batches.

### Operation vocabulary

Discriminated union on `type`. Verbs and field names mirror the runtime-edit schema
(`add`/`update`/`remove`/`reorder`/`move`, `taskId`/`contextId`). Partial-update ops touch
only the fields present; absent fields are untouched.

| `type` | fields | notes |
|---|---|---|
| `update-workflow` | `name?`, `description?` | record-level metadata |
| `update-charter` | `mission?`, `conventions?`, `nonGoals?`, `vocabulary?`, `testStrategy?`, `knownAmbiguities?`, `sourcesOfTruth?` | arrays replace wholesale (entries are short; item-level ops are a v2 candidate if audits show friction) |
| `update-workflow-config` | any of the nine cascade blocks (`implementer`, `contextValidator`, `scriptValidator`, `iterationPolicy`, `circuitBreaker`, `mutability`, `collaboration`, `humanApprovalGate`, `askUserQuestions`) | `null` **clears** an override (restores cascade inheritance) — deleting an override is a first-class need |
| `add-context` | `id`, `title`, `acceptanceCriteria`, `description?`, `outputSchema?`, + optional per-context config blocks | same shape as a plan.json context |
| `update-context` | `contextId`, `title?`, `description?`, `acceptanceCriteria?`, `outputSchema?`, + config blocks | `null` clears a per-context override, same as workflow config; `outputSchema` is not an override — present replaces the declaration wholesale, `null` drops it |
| `remove-context` | `contextId`, `deleteTasks?` | edges touching the context always cascade; refuses a context that still has tasks unless `deleteTasks: true` (protects prose from silent deletion) |
| `add-task` | `id`, `contextId`, `title`, `instructions`, `metadata?`, `position?` | `position`: `{"at":"start"\|"end"}` \| `{"after":"<taskId>"}` \| `{"before":"<taskId>"}`; default end |
| `update-task` | `taskId`, `title?`, `instructions?`, `metadata?` | |
| `remove-task` | `taskId` | |
| `move-task` | `taskId`, `contextId?`, `position?` | omitted `contextId` = reposition within its context |
| `reorder-tasks` | `contextId`, `orderedTaskIds` | must be an exact permutation of the context's tasks |
| `add-edge` | `sourceContextId`, `targetContextId` | edge id server-minted; duplicate pair → `edge-already-exists` |
| `remove-edge` | `sourceContextId`, `targetContextId` | addressed by pair, not id (edge ids are noise to agents) |
| `add-parameter` | `declaration` | full `ParameterDeclaration` |
| `update-parameter` | `name`, `declaration` | whole-declaration replacement (partial update of a discriminated union invites shape bugs) |
| `remove-parameter` | `name` | a still-referenced `{{inputs.<name>}}` fails the post-batch lint — caught, not silently broken |
| `add-prerequisite` | `prerequisite` | full `WorkflowPrerequisite` |
| `remove-prerequisite` | `kind` + `path`/`skill` | matched by identity (prerequisites have no ids) |

Design choices worth calling out:

- **Ids are agent-supplied and required on `add-context`/`add-task`** (as in plan.json).
  Server-minted ids would break intra-batch references (add a task, then move it).
- **Task `order` is never written by agents.** Position is expressed relatively
  (`after`/`before`/`start`/`end`); the server renumbers each touched context to a dense
  1..n after every task op. The `duplicate-task-order` invariant becomes unviolable and
  agents do no order arithmetic.
- **No rename-id ops.** Renaming a context/task id cascades through tasks and edges;
  expressible as add+move+remove when genuinely needed. YAGNI for v1.
- **Ops arrive as a JSON file, not inline flags.** Multi-line prose in shell flags is a
  known agent failure mode (quoting), and one uniform vocabulary beats 18 flag surfaces in
  the help registry. Supporting `--file -` (stdin) lets an agent do a single Bash heredoc
  call for small edits — one tool call, no scratch file. Scratch files go under `.cc/temp/`
  per the existing convention.

### Error contract

Per the CLI steering error floor:

- Malformed ops file (JSON parse, unknown `type`, missing fields) → **exit 2** locally,
  before any network round-trip, one issue per line.
- Per-op precondition failures and post-batch graph errors → **exit 1** with structured
  `issues[]`, locator-first:

```
operations[0]: unknown-task-id — no task "impl-9" in this definition
operations[3]: edge-already-exists — impl → docs
graph: cycle-detected — plan → impl → plan
```

- `revision_conflict` → exit 1, `code: "revision_conflict"`, payload carries
  `currentRevision`, hint names `cctl workflow get <id>`.

### Success response

```
{ ok, workflowId, revision, applied }        // applied = op count
```

Text mode: `edited "tailwind-stage-b1": 4 operations applied, revision 8`.

**Hint (state-conditional, best-effort):** when an active execution launched from this
definition exists, append `hint: a running execution uses its own working copy; this edit
does not affect it — start a fresh execution to pick it up`. This is a hint, not a reminder
(it's advisory; reminders require earned incident evidence per the steering).

## Server surface

New endpoint: `PATCH /api/projects/[name]/workflows/[workflowId]`
(body `{ expectedRevision, dryRun?, operations[] }`) in
`src/lib/workflows/definition-route-handlers.ts`, wired through the existing
`src/app/api/projects/[name]/workflows/[workflowId]/route.ts` shell. Global tier (if
in scope): same handler shape on `/api/workflow-templates/[id]`.

- 200 `{ item: { id, name, revision }, applied }`
- 400 `{ error, issues[] }` (op preconditions + post-batch validation, all collected)
- 404 unknown workflow · 409 `{ error, code: "revision_conflict", currentRevision }`

Core logic is a **pure function** (per the agent-offloading and testing principles):

```
// src/lib/workflow-graph/definition-edits.ts
applyDefinitionEdits(record: WorkflowDefinitionRecord, operations: DefinitionEditOperation[])
  : { ok: true; record: WorkflowDefinitionRecord } | { ok: false; issues: WorkflowGraphValidationError[] }
```

It applies ops sequentially (collecting precondition issues with `operations[i]` locators),
renumbers task orders, maintains `layout` (preserve existing positions, auto-place added
contexts with the same helper the create path uses to inflate layout-less plans, drop
removed ones), then runs `validateAuthoredDefinition` on the result. The route handler is a
thin shell: resolve record → revision check → `applyDefinitionEdits` → `storage.update()`.

Op schemas live in `src/lib/workflows/schemas.ts`
(`workflowDefinitionEditOperationSchema`, `workflowDefinitionEditRequestSchema`) so the CLI
and server share one source of truth — the CLI parses the ops file with the same schema for
its exit-2 local check; the server re-validates authoritatively.

## Why invariants cannot be violated

1. Zod shape validation on the request (CLI locally at exit 2, server authoritatively).
2. Per-op semantic preconditions during apply (unknown ids, duplicate ids, non-empty
   context removal, permutation checks) — collected, locator-tagged.
3. Post-batch `validateAuthoredDefinition` on the complete mutated definition — the same
   composite gate as `create`/`replace` (structure, DAG, parameters, lint, prerequisites).
4. `storage.update()` re-asserts validity at the choke point and mints the revision.

A batch either produces a definition indistinguishable from one accepted via `create`, or
nothing changes.

## Token-efficiency check

Typical definition: 15–30 KB ≈ 4–8k tokens.

| Flow | Today (get-full + replace) | Proposed (outline + edit) |
|---|---|---|
| Fix one task's instructions | ~8–16k tokens | ~0.5–1k tokens |
| Add a context with 2 tasks + edge | ~8–16k tokens | ~1–1.5k tokens (mostly the new prose itself) |
| Restructure half the graph | ~8–16k tokens | comparable to replace — `replace` stays the right tool |

`replace` is retained for wholesale recomposition; `edit`'s help node cross-links it.

## Integration checklist (per `.kiro/steering/cli.md`)

- `CommandHelpEntry` additions in `src/cli/commands/workflow.help.ts`: `edit` leaf
  (rich — full op vocabulary + ≥2 examples teaching the failure-prone shapes: ops-file
  skeleton, position syntax, null-to-clear); `get` updated (selectors, `--full`).
- Flags wired through the registry (never literal allowlists); `related` edges both ways:
  `edit ↔ get ↔ replace ↔ validate`; `skills` ref to `graph-workflow-planning` on `edit`.
- Registry contract test (`help-registry.contract.test.ts`) green.
- `cc-cli` SKILL.md command reference updated.
- `graph-workflow-planning` SKILL.md revision section rewritten: targeted edits via
  `edit` are the default revision path; `replace` for recomposition; note that saved-
  definition edits never mutate a live execution.
- Structured logging per `.kiro/steering/logs.md` (workflow-graph module; edit-applied /
  edit-rejected events with op counts and error codes).

## Non-goals / future seams

- **Runtime (in-flight) editing via CLI** — the runtime-edits endpoint stays UI-only for
  now. If audits show demand, expose it as a sibling command reusing the task-op subset of
  this vocabulary (the alignment is deliberate).
- **Charter `sourcesOfTruth` item-level ops** — v2 if wholesale array replacement shows up
  as friction in workflow audits.
- **Rename-id ops, layout editing, multi-selector reads** — omitted; expressible or
  cosmetic.

## Decisions (confirmed with Alex, 2026-07-07)

1. **`get` default → outline**, `--full` opt-in. Breaking change to today's full dump is
   accepted; the token-safe path becomes the default.
2. **`expectedRevision` required** — optimistic concurrency enforced; mismatch → `stale_workflow_definition`.
3. **Project + global tiers** via `--tier global` (same storage choke point).
4. **Saved definitions only in v1** — the runtime-edits endpoint stays UI-only; a sibling
   CLI command reusing the aligned task-op vocabulary is a future seam.
