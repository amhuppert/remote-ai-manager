import { EXPANSION_CAPS } from "@/lib/workflow-graph/expansion-caps";
import type { CommandHelpEntry } from "../help-types";

/**
 * Help-registry entries for `cctl workflow` (docs/design/cc-cli/04 §2.2/§2.4):
 * the group hub, the authoring/lifecycle leaves (validate/create/replace/list/
 * get/status/start/delete/templates), and the lane-verb family (task
 * complete/add, shared-doc upsert, collab request) under their own group nodes.
 * Ported from the legacy `help.ts` block and the cc-cli SKILL.md; flags match
 * `workflow.ts`'s per-verb `checkFlags`. Related edges follow the one hint
 * vocabulary: validate → create → start → status (`.kiro/steering/cli.md`).
 */

const GRAPH_PLANNING_SKILL = {
  name: "graph-workflow-planning",
  loadWhen: "before authoring or revising a plan.json",
  path: ".claude/skills/graph-workflow-planning/SKILL.md",
} as const;

/**
 * The lane-family invariant, stated on every lane verb: it resolves the lane's
 * execution + context from the env CC injects at spawn, and runs outside a lane
 * fail with an exit-2 naming the missing variable.
 */
const LANE_NOTE =
  "Lane verb: works only inside a graph-workflow lane conversation, where CC injects CC_WORKFLOW_EXECUTION_ID / CC_WORKFLOW_CONTEXT_ID — you never pass them. Run it outside a lane and it exits 2 naming the missing variable. Every lane verb runs the execution's halt check first: a halted/blocked run exits 1 printing the halt reason — stop and end your turn.";

/**
 * The expansion ceilings, rendered from the same constant the server enforces so
 * the help text cannot drift from the refusal an agent will actually hit.
 */
const EXPANSION_CAPS_NOTE = `Bounded: per request ${EXPANSION_CAPS.contextsPerRequest} contexts, ${EXPANSION_CAPS.tasksPerRequest} tasks, ${EXPANSION_CAPS.edgesPerRequest} edges, and ${EXPANSION_CAPS.canonicalPayloadBytes / 1024} KB of canonical JSON; cumulatively ${EXPANSION_CAPS.contextsPerAddingContext} generated contexts per adding context and ${EXPANSION_CAPS.contextsPerExecution} per execution. The cumulative budgets are counted from permanent acceptance receipts, so removing a generated context never returns budget.`;

export const workflowHelpEntries: CommandHelpEntry[] = [
  {
    path: ["workflow"],
    dynamicContext: true,
    summary: "list, inspect, start, and delete graph workflows",
    description:
      "Author, read, launch, and inspect graph workflows — saved multi-context task graphs and their live executions. Authoring walks the canonical chain validate → create → start. The lane verbs (task complete/add, shared-doc upsert, collab request) are a SEPARATE family for the implementer agent inside a running execution.",
    usage: [
      "cctl workflow <validate|create|replace|edit|list|get|status|start|delete|templates>",
      "cctl workflow <task complete|task add|shared-doc upsert|collab request>  (lane verbs)",
    ],
    flags: [],
    examples: [],
    domainContext:
      "Author every --file payload under .cc/temp/ — it is git-ignored, so a lane's land-time commit ('git add -A') never sweeps it into the branch.",
    related: [],
    skills: [GRAPH_PLANNING_SKILL],
  },
  {
    path: ["workflow", "validate"],
    dynamicContext: true,
    summary: "check a plan.json without saving anything",
    description:
      "Check a plan.json against the EXACT create-path rules (the create Zod parse plus graph structural checks: dependency cycles, unknown context refs, prerequisite sanity, edge-guard and loop-group validation) plus the agent-profile assignment references it names, without saving. On issues it exits 2 and prints one issue per line with its JSON path (e.g. definition.tasks.2.contextId: …) — fix the file and re-run. A valid plan may still print `warning: <path>: <message>` lines above the create hint and exit 0 — an unrouted enum value in a guard set is legal but usually unintended; answer it with another branch or an `else` edge. Assignment issues read identically whichever check produced them (a malformed id and a dangling profile reference are found by different layers): the path locates the offending field, e.g. definition.executionContexts.2.contextValidator.assignments.1.profile, and the message names the qualified tier:id and the exact use site (context, role, assignment id). Validation is ADVISORY — a profile can be deleted between the check and the save — so `create`, `replace`, and `edit` re-check at accept time and refuse with those same located lines (`edit` exits 1, since the batch was well-formed and the server refused it). Session-scoped. Validate under the scope the plan is destined for: --tier global applies the global-document rule, which refuses project-tier profile references.",
    usage: [
      "cctl workflow validate --file .cc/temp/plan.json [--tier global|project] [--json]",
    ],
    flags: [
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<plan.json>",
        description: "the plan authored per the graph-workflow-planning skill",
      },
      {
        name: "tier",
        kind: "value",
        valuePlaceholder: "global|project",
        description:
          "check as a global-library template (refuses project-tier profile refs) instead of a project definition",
      },
    ],
    examples: [
      {
        invocation: "cctl workflow validate --file .cc/temp/plan.json",
        explanation:
          "always validate first — exit 2 lists issues one per line with their JSON path; on success it hints the create command",
      },
      {
        invocation:
          "cctl workflow validate --file .cc/temp/plan.json --tier global",
        explanation:
          "pre-flight a shared template: a global document may only reference builtin and global agent profiles, so a project-tier ref is refused here rather than at save",
      },
    ],
    related: [
      {
        command: "workflow create",
        oneLiner: "save the validated plan as a new definition",
      },
      {
        command: "workflow edit",
        oneLiner:
          "for a targeted change, edit in place instead of re-validating a whole plan",
      },
    ],
    skills: [GRAPH_PLANNING_SKILL],
  },
  {
    path: ["workflow", "create"],
    dynamicContext: true,
    summary: "save a new definition from a validated plan",
    description:
      "Save a new definition from a validated plan.json. Prints the new workflow id and hints how to start it. The user reviews and edits it in the visual builder before starting.",
    usage: ["cctl workflow create --file .cc/temp/plan.json [--json]"],
    flags: [
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<plan.json>",
        description: "the validated plan to save",
      },
    ],
    examples: [
      {
        invocation: "cctl workflow create --file .cc/temp/plan.json",
        explanation:
          "returns the workflow id; start it with 'cctl workflow start <id>' after the user reviews it",
      },
    ],
    related: [
      {
        command: "workflow validate",
        oneLiner: "pre-flight the plan before creating anything",
      },
      {
        command: "workflow start",
        oneLiner: "launch an execution from the id",
      },
    ],
    skills: [GRAPH_PLANNING_SKILL],
  },
  {
    path: ["workflow", "replace"],
    dynamicContext: true,
    summary: "overwrite an existing definition from a plan file",
    description:
      "Overwrite an existing definition (<id>) with a plan.json — submit the COMPLETE graph, not a diff (the previous definition is fully overwritten). For a targeted change (one task, add a context, clear an override) prefer `cctl workflow edit` — far cheaper. Re-validate first. No hint — a revision is not a step in the author-then-start chain.",
    usage: ["cctl workflow replace <id> --file .cc/temp/plan.json [--json]"],
    flags: [
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<plan.json>",
        description: "the complete replacement graph (not a diff)",
      },
    ],
    examples: [
      {
        invocation: "cctl workflow replace wf-1 --file .cc/temp/plan.json",
        explanation:
          "fully overwrites wf-1 — `cctl workflow get wf-1 --full` first, edit the whole graph, re-validate, then replace",
      },
    ],
    related: [
      {
        command: "workflow edit",
        oneLiner:
          "apply a targeted, atomic edit instead of resubmitting the whole graph",
      },
      {
        command: "workflow get",
        oneLiner: "print the current definition to edit before replacing",
      },
      {
        command: "workflow validate",
        oneLiner: "re-validate the complete graph before replacing",
      },
    ],
    skills: [GRAPH_PLANNING_SKILL],
  },
  {
    path: ["workflow", "list"],
    dynamicContext: true,
    summary: "list this project's saved workflow definitions",
    description:
      "List this project's saved workflow definitions (id  name (rev N)  —  description). Project-scoped; needs no session. No hint.",
    usage: ["cctl workflow list [--json]"],
    flags: [],
    examples: [
      {
        invocation: "cctl workflow list",
        explanation:
          "copy an id to pass to `cctl workflow get`, `start`, `replace`, or `delete`",
      },
    ],
    related: [
      { command: "workflow get", oneLiner: "print one definition's full JSON" },
      { command: "workflow create", oneLiner: "save a new definition" },
    ],
  },
  {
    path: ["workflow", "get"],
    dynamicContext: true,
    summary: "print a definition's outline (or one section, or the full JSON)",
    description:
      "Print a saved definition's compact OUTLINE by default — structure, ids, per-context task counts + deps, declared output-schema shapes (e.g. `output schema: object · 4 fields`), and prose SIZES (not bodies). It is the navigation map for a targeted `cctl workflow edit`: it shows every id an edit addresses and the current revision, in a few hundred tokens. The `staffing (references)` block lists every agent assignment the document authors — scope, role, assignment id, the qualified `tier:id` profile reference, strategy, and runtime. A SAVED definition is reference-bearing: it names profiles the library still owns and resolves nothing, so these rows carry no profile revision and no resolved-instruction hash. Assignments retained by a switched-off cohort are listed too, marked `(cohort disabled)`. Use `cctl workflow live get` for what a running execution actually resolved. Section selectors fetch ONE full-prose slice (--context/--task/--charter/--config/--params); --full prints the entire record for a wholesale `replace`. At most one selector per invocation. An unknown id exits 2. No hint.",
    usage: [
      "cctl workflow get <id> [--full | --context <ctx> | --task <task> | --charter | --config | --params] [--tier global|project] [--json]",
    ],
    flags: [
      {
        name: "full",
        kind: "boolean",
        description:
          "print the entire WorkflowDefinitionRecord (the pre-outline behavior)",
      },
      {
        name: "context",
        kind: "value",
        valuePlaceholder: "<ctx>",
        description: "one context (full prose + config) and its tasks",
      },
      {
        name: "task",
        kind: "value",
        valuePlaceholder: "<task>",
        description: "one task, full instructions + metadata",
      },
      {
        name: "charter",
        kind: "boolean",
        description: "the charter only",
      },
      {
        name: "config",
        kind: "boolean",
        description: "workflowConfig + per-context override blocks only",
      },
      {
        name: "params",
        kind: "boolean",
        description: "parameters + prerequisites",
      },
      {
        name: "tier",
        kind: "value",
        valuePlaceholder: "global|project",
        description:
          "read a global-library template instead of this project's definition",
      },
    ],
    examples: [
      {
        invocation: "cctl workflow get wf-1",
        explanation:
          "the outline IS the edit map — read it first, note the revision, then fetch only the piece you'll change",
      },
      {
        invocation: "cctl workflow get wf-1 --task impl-tokens",
        explanation:
          "pulls one task's full instructions (the outline shows sizes, not bodies) — a cheap targeted read before `cctl workflow edit`",
      },
      {
        invocation: "cctl workflow get wf-1 --config",
        explanation:
          "the raw assignment blocks behind the staffing rows — edit a profile reference or a cohort here, then re-validate",
      },
    ],
    related: [
      {
        command: "workflow edit",
        oneLiner: "apply targeted edits addressed by the ids the outline shows",
      },
      { command: "workflow list", oneLiner: "find the id to inspect" },
      {
        command: "workflow replace",
        oneLiner: "overwrite the whole definition (get it with --full first)",
      },
      {
        command: "agent get",
        oneLiner:
          "read the instructions behind a profile reference the staffing block names",
      },
    ],
  },
  {
    path: ["workflow", "edit"],
    dynamicContext: true,
    summary: "apply targeted, atomic edits to a saved definition",
    description:
      'Apply an ordered batch of domain operations to a saved definition, addressed by STABLE IDS (never array indices) — cost proportional to the change, not the whole plan. --file is a JSON object { baseRevision, operations[] }; baseRevision is the revision `cctl workflow get` shows (a stale value exits 1 revision_conflict — re-read and retry). Operations apply SEQUENTIALLY (later ops see earlier ones — add a context, then its tasks, then its edges in one batch) and ATOMICALLY (any per-op or post-batch validation error rejects the whole batch; nothing persists). Ops (verbs mirror the runtime task-edit vocabulary): update-workflow, update-charter, update-workflow-config, add/update/remove-context, add/update/remove/move-task, reorder-tasks, add/update/remove-edge, add/update/remove-parameter, add/remove-prerequisite. An edge may carry an activation guard: `when: { "schema": { … } }` (a supported-subset JSON Schema the source context\'s captured output must match) or `when: { "else": true }` (taken when no conditional sibling from that source activated) — the source must declare an outputSchema, the guard must be compatible with it, and one source admits at most one else edge. update-edge is addressed by edgeId (when: null clears the guard); remove-edge takes edgeId, or an endpoint pair when it matches exactly one edge. Task order is never written by hand — place with position {"at":"start|end"} | {"after":"<id>"} | {"before":"<id>"}. A config/override field set to null CLEARS it (restores cascade inheritance). Malformed ops exit 2; a rejected batch exits 1 with locator-first issues (operations[i]: <code> — <detail>).',
    usage: [
      "cctl workflow edit <id> --file .cc/temp/ops.json [--dry-run] [--tier global|project] [--json]",
    ],
    flags: [
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<ops.json>",
        description:
          'JSON object { "baseRevision": N, "operations": [ … ] } (or - to read from stdin)',
      },
      {
        name: "dry-run",
        kind: "boolean",
        description: "apply + validate + report the outcome, persist nothing",
      },
      {
        name: "tier",
        kind: "value",
        valuePlaceholder: "global|project",
        description:
          "edit a global-library template instead of this project's definition",
      },
    ],
    examples: [
      {
        invocation: "cctl workflow edit wf-1 --file .cc/temp/ops.json",
        explanation:
          'ops.json: { "baseRevision": 7, "operations": [ { "type": "update-task", "taskId": "impl-tokens", "instructions": "…" } ] } — take baseRevision from `cctl workflow get`',
      },
      {
        invocation:
          "cctl workflow edit wf-1 --file .cc/temp/ops.json --dry-run",
        explanation:
          'pre-flight a risky batch — e.g. add a task with "position": {"after":"impl-tokens"} and clear an override with "contextValidator": null; --dry-run persists nothing',
      },
    ],
    related: [
      {
        command: "workflow get",
        oneLiner: "read the outline for the ids + baseRevision to edit against",
      },
      {
        command: "workflow live edit",
        oneLiner:
          "edit the RUNNING execution's working copy instead of the saved definition",
      },
      {
        command: "workflow replace",
        oneLiner:
          "recompose the WHOLE graph when a targeted edit is not enough",
      },
      {
        command: "workflow validate",
        oneLiner: "pre-flight a full plan before a replace",
      },
    ],
    skills: [GRAPH_PLANNING_SKILL],
    domainContext:
      "A running execution uses its own working copy — editing the saved definition does not affect it; start a fresh execution to pick up the change.",
  },
  {
    path: ["workflow", "status"],
    dynamicContext: true,
    summary: "show this session's active execution",
    description:
      "The workflow call you reach for most. Prints a compact per-context table for this session's active execution (<context id>  <state>  <completed>/<total>), with the execution id and any halt reason on the header line. With --json it returns the full execution payload. When nothing is running it says so plainly. No hint.",
    usage: ["cctl workflow status [--json]"],
    flags: [],
    examples: [
      {
        invocation: "cctl workflow status",
        explanation:
          "no id needed — reports this session's running execution; --json returns the full payload",
      },
    ],
    related: [
      {
        command: "workflow start",
        oneLiner: "launch an execution to track here",
      },
      { command: "workflow list", oneLiner: "see saved definitions to start" },
      {
        command: "workflow live",
        oneLiner:
          "read/edit the active execution in place (get/edit/pause/resume)",
      },
    ],
  },
  {
    path: ["workflow", "start"],
    dynamicContext: true,
    summary: "launch an execution from a saved definition",
    description:
      "Launch an execution from a saved definition id. --file supplies a JSON OBJECT of launch parameter values (the {{inputs.<name>}} a template declares); a missing/invalid/non-object file exits 2. A guard rejection (a run already active, uncommitted worktree changes, unmet prerequisites) exits 1 with the reason. On success it hints to track progress with `cctl workflow status`.",
    usage: ["cctl workflow start <id> [--file .cc/temp/inputs.json] [--json]"],
    flags: [
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<inputs.json>",
        description:
          "JSON object of {{inputs.<name>}} values a template declares",
      },
    ],
    examples: [
      {
        invocation: "cctl workflow start wf-1 --file .cc/temp/inputs.json",
        explanation:
          "the payload is a JSON object of launch-parameter values; then track with 'cctl workflow status'",
      },
    ],
    related: [
      {
        command: "workflow status",
        oneLiner: "track the execution you just started",
      },
      {
        command: "workflow create",
        oneLiner: "create the definition to start",
      },
    ],
  },
  {
    path: ["workflow", "delete"],
    dynamicContext: true,
    summary: "permanently remove a saved definition",
    description:
      "Permanently remove a saved definition by id. An unknown id exits 2. Terminal: no hint.",
    usage: ["cctl workflow delete <id>"],
    flags: [],
    examples: [
      {
        invocation: "cctl workflow delete wf-1",
        explanation:
          "the id comes from `cctl workflow list`; this is irreversible",
      },
    ],
    related: [
      { command: "workflow list", oneLiner: "find the id to delete" },
      {
        command: "workflow get",
        oneLiner: "inspect the definition before deleting",
      },
    ],
  },
  {
    path: ["workflow", "templates"],
    dynamicContext: true,
    summary: "list saved workflow templates across both tiers",
    description:
      "List saved templates across BOTH tiers: the cross-project global library and this project's project library, each row tier-tagged (<tier>  <id>  <name>). --tier global|project filters to one tier. No hint.",
    usage: ["cctl workflow templates [--tier global|project] [--json]"],
    flags: [
      {
        name: "tier",
        kind: "value",
        valuePlaceholder: "global|project",
        description: "filter to one tier (both are listed by default)",
      },
    ],
    examples: [
      {
        invocation: "cctl workflow templates --tier project",
        explanation:
          "lists this project's templates; drop --tier to see the global library too",
      },
    ],
    related: [
      {
        command: "workflow start",
        oneLiner: "start a definition, supplying its declared inputs",
      },
    ],
  },

  // --- Live execution editing (doc 06) ----------------------------------------
  {
    path: ["workflow", "live"],
    dynamicContext: true,
    summary: "act on this session's ACTIVE launched execution",
    description:
      "Read and edit the session's running (or paused/resumably-halted) graph-workflow execution in place — per-context config, task, and safe structural edits — plus pause/resume. Aliases: `workflow execution …` and `workflow exec …` are rewritten to `live`. This edits the LIVE execution's working copy; `workflow edit` edits a SAVED definition and does not touch a running run. The canonical loop is get → pause → edit → resume.",
    usage: ["cctl workflow live <get|ledger|edit|pause|resume>"],
    flags: [],
    examples: [
      {
        invocation:
          "cctl workflow live get && cctl workflow live pause && cctl workflow live edit --file .cc/temp/live-ops.json && cctl workflow live resume",
        explanation:
          "the canonical loop: read the outline for ids + liveRev, pause to unlock a started context, apply the edits, resume",
      },
    ],
    related: [
      {
        command: "workflow status",
        oneLiner: "the compact per-context table for the active execution",
      },
      {
        command: "workflow edit",
        oneLiner: "edit a SAVED definition instead of the running execution",
      },
    ],
    skills: [GRAPH_PLANNING_SKILL],
  },
  {
    path: ["workflow", "live", "get"],
    dynamicContext: true,
    summary: "print the live outline of the active execution",
    description:
      "Print the ACTIVE execution's live outline — a compact, server-projected map: the header (executionId, liveRevision, status, seed id@revision, whether it is editable, charter amendment count, plan-repair round count), per-context rows (status, editability tier frozen/editable/pause-to-edit from the shared lifecycle classifier, deps, task progress, iteration progress, and — when the context declares an outputSchema — its shape, e.g. `output schema: object · 4 fields`), per-task rows (id, order, status, title, instruction SIZE — never inlined), a one-line config summary per context, and a `staffing (snapshots)` block. Staffing lists one row per SEEDED assignment — context, role, assignment id, the profile as `tier:id@revision`, the short resolved-instruction hash, and the runtime. Those last two are what a live execution has that a saved definition does not: execution start resolved every assignment once and nothing consults the profile library again, so these rows are what is actually running (`cctl workflow get` shows the bare references the document authored). Two rows sharing a hash are replaying identical instructions. Assignments retained by a switched-off cohort are listed too, marked `(cohort disabled)`: they are snapshotted and a live edit can enable them without any library lookup, but nothing dispatches them — which is why the `config:` line above still reads `validator off`. The profile identity in these rows comes from the snapshot, not the authored reference. The header's liveRev is the value an edit's baseLiveRevision must match. Selectors: --context <ctx> (full prose + resolved config + full task instructions for one context), --task <task> (full instructions), --config <ctx> (one context's full resolved config — implementer, validator, script/approval/questions gates, iteration policy, circuit breaker, mutability, plan repair, collaboration, and the outputSchema declaration itself), --charter (the current charter document rendered with its amendment log), --outputs (every schema-declaring context's capture status, plus the captured payload and its parse provenance), --full (every context expanded). At most one selector. No active execution exits 2.",
    usage: [
      "cctl workflow live get [--context <ctx> | --task <task> | --config <ctx> | --charter | --outputs | --full] [--json]",
    ],
    flags: [
      {
        name: "full",
        kind: "boolean",
        description: "expand every context: full prose + config + full tasks",
      },
      {
        name: "charter",
        kind: "boolean",
        description:
          "the current charter document (markdown) with its live amendment log",
      },
      {
        name: "outputs",
        kind: "boolean",
        description:
          "each schema-declaring context's structured output: captured or pending, with the payload + parse provenance",
      },
      {
        name: "context",
        kind: "value",
        valuePlaceholder: "<ctx>",
        description: "one context: full prose + resolved config + its tasks",
      },
      {
        name: "task",
        kind: "value",
        valuePlaceholder: "<task>",
        description: "one task: full instructions + metadata",
      },
      {
        name: "config",
        kind: "value",
        valuePlaceholder: "<ctx>",
        description:
          "one context's full resolved config (concrete runtime values, for a targeted `live edit`)",
      },
    ],
    examples: [
      {
        invocation: "cctl workflow live get",
        explanation:
          "the outline IS the edit map — note the header's liveRev, then set it as baseLiveRevision in the ops file",
      },
      {
        invocation: "cctl workflow live get --context impl",
        explanation:
          "pulls one context's full prose + resolved config before a targeted `cctl workflow live edit`",
      },
      {
        invocation: "cctl workflow live get --outputs",
        explanation:
          "reads what upstream contexts actually produced — the outline only says a context DECLARES an outputSchema; this returns the validated payload",
      },
    ],
    related: [
      {
        command: "workflow live edit",
        oneLiner:
          "apply edits addressed by the ids + liveRev the outline shows",
      },
      {
        command: "workflow status",
        oneLiner: "the shorter per-context progress table",
      },
    ],
    skills: [GRAPH_PLANNING_SKILL],
  },
  {
    path: ["workflow", "live", "ledger"],
    dynamicContext: true,
    summary: "print the active execution's loop ledger",
    description:
      "Print the loop ledger of the ACTIVE execution: one block per declared loop group with its activation (unstarted/running/concluded/skipped), the passes it has materialized against its cap, and its current loop-control revision — then every decision each pass was given, oldest first. Current state comes from the execution's loop markers; the decision HISTORY is walked from the append-only event log through the cursor-paginated reader, so a pass re-decided under an amended control revision shows BOTH records, the older one marked `superseded`. A decision the walk did not reach is marked `from current state` (it came from the markers). Each PAGE of the reader is bounded, the walk is not: by default it reads to the end of the log, so the history is always complete. --max-pages bounds one invocation and the output then prints the exact --cursor to continue from; --cursor starts a walk after that event sequence number. Any walk that stops short says so. An execution with no loop groups says so and reads no events. No active execution exits 2.",
    usage: [
      "cctl workflow live ledger [--cursor <seq>] [--max-pages <n>] [--json]",
    ],
    flags: [
      {
        name: "cursor",
        kind: "value",
        valuePlaceholder: "<seq>",
        description:
          "start the event walk AFTER this sequence number (the resume cursor a bounded walk prints)",
      },
      {
        name: "max-pages",
        kind: "value",
        valuePlaceholder: "<n>",
        description:
          "read at most n pages of 500 events, then print the cursor to resume from (default: read to the end)",
      },
    ],
    examples: [
      {
        invocation: "cctl workflow live ledger",
        explanation:
          "why is this loop still running (or why did it stop) — the verdict and outcome of every pass, with the control revision each was decided under",
      },
      {
        invocation: "cctl workflow live ledger --json",
        explanation:
          "the derived ledger as data: one entry per loop with its slot grants and full decision history",
      },
      {
        invocation: "cctl workflow live ledger --max-pages 4 --cursor 2000",
        explanation:
          "walk a very long event log in bounded chunks — each run prints the --cursor for the next one",
      },
    ],
    related: [
      {
        command: "workflow live get",
        oneLiner: "the outline the pass instances appear in",
      },
      {
        command: "workflow status",
        oneLiner: "the per-context progress table for the same execution",
      },
    ],
    skills: [GRAPH_PLANNING_SKILL],
  },
  {
    path: ["workflow", "live", "edit"],
    dynamicContext: true,
    summary: "apply live edits to the running execution's working copy",
    description:
      'Apply an ordered, atomic batch of live edits to the ACTIVE execution\'s working copy, addressed by STABLE IDS. --file is a JSON object { "executionId", "baseLiveRevision", "operations": [ … ] }; the CLI always sends source "cli". baseLiveRevision must equal the header\'s liveRev from `cctl workflow live get` (a stale value exits 1 revision_conflict — re-read and retry). Completed contexts are frozen; not-started contexts are fully editable while running; started contexts need a pause first (pause-to-edit). Structural ops (add/remove-context, add/update/remove-edge) require a quiescent execution and an unstarted edge target. Edge guards use the same `when` vocabulary as `workflow edit`: add-edge accepts `when`, update-edge is addressed by edgeId (when: null clears it), and remove-edge takes edgeId or an unambiguous endpoint pair. A code-bearing rejection (execution_mismatch/revision_conflict/not_editable/frozen/requires_pause/invalid_edit) exits 1 with issues one per line and the code on the --json envelope; a malformed file or missing execution exits 2 (deterministic local checks fail before any network call). --dry-run validates and reports without persisting.',
    usage: [
      "cctl workflow live edit --file .cc/temp/live-ops.json [--dry-run] [--json]",
    ],
    flags: [
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<live-ops.json>",
        description:
          'JSON object { "executionId", "baseLiveRevision", "operations": [ … ] } (or - for stdin)',
      },
      {
        name: "dry-run",
        kind: "boolean",
        description: "validate + report the outcome, persist nothing",
      },
    ],
    examples: [
      {
        invocation: "cctl workflow live edit --file .cc/temp/live-ops.json",
        explanation:
          'live-ops.json under .cc/temp/: { "executionId": "exec-7", "baseLiveRevision": 4, "source": "cli", "operations": [ { "type": "update-context", "contextId": "verify", "implementer": { "id": "implementer", "profile": { "tier": "builtin", "id": "general-implementer" }, "agent": { "backend": "claude", "model": "opus", "reasoningEffort": "high" } } } ] } — take baseLiveRevision from `cctl workflow live get`',
      },
      {
        invocation:
          "cctl workflow live pause && cctl workflow live edit --file .cc/temp/live-ops.json && cctl workflow live resume",
        explanation:
          "the canonical loop for editing a started (pause-to-edit) context: pause, edit, resume",
      },
    ],
    related: [
      {
        command: "workflow live get",
        oneLiner: "read the outline for the ids + liveRev to edit against",
      },
      {
        command: "workflow edit",
        oneLiner:
          "edit the SAVED definition (not the running execution); start a fresh run to pick it up",
      },
      {
        command: "workflow live pause",
        oneLiner: "pause first to edit a started (pause-to-edit) context",
      },
    ],
    skills: [GRAPH_PLANNING_SKILL],
    domainContext:
      "Live edits mutate only the execution's working copy — the saved definition is untouched, and a saved-definition edit never leaks into a running execution.",
  },
  {
    path: ["workflow", "live", "pause"],
    dynamicContext: true,
    summary: "pause the active execution to unlock started contexts",
    description:
      "Pause the ACTIVE execution — interrupts running tasks and demotes active contexts so a `started` (pause-to-edit) context becomes editable. Pausing an already-paused or terminal execution exits 1 with the server's message; no active execution exits 2. No body flags in v1.",
    usage: ["cctl workflow live pause [--json]"],
    flags: [],
    examples: [
      {
        invocation: "cctl workflow live pause",
        explanation:
          "step 1 of the pause → edit → resume loop when the outline shows a context as pause-to-edit",
      },
    ],
    related: [
      {
        command: "workflow live edit",
        oneLiner: "apply the edits once paused",
      },
      {
        command: "workflow live resume",
        oneLiner: "resume the execution after editing",
      },
    ],
  },
  {
    path: ["workflow", "live", "resume"],
    dynamicContext: true,
    summary: "resume a paused or resumably-halted execution",
    description:
      "Resume the ACTIVE execution after a pause or a resumable halt, re-entering the scheduler loop so accepted edits take effect on the next tick. Resuming a running execution exits 1 with the server's message; no active execution exits 2. No body flags in v1.",
    usage: ["cctl workflow live resume [--json]"],
    flags: [],
    examples: [
      {
        invocation: "cctl workflow live resume",
        explanation:
          "final step of the pause → edit → resume loop; the scheduler picks up the edits on the next tick",
      },
    ],
    related: [
      {
        command: "workflow live pause",
        oneLiner: "pause the execution before editing",
      },
      {
        command: "workflow live edit",
        oneLiner: "the edits applied between pause and resume",
      },
    ],
  },

  // --- Lane verbs (a separate family) -----------------------------------------
  {
    path: ["workflow", "task"],
    dynamicContext: true,
    summary: "advance a running lane — complete or add tasks",
    description:
      "Lane verbs for the implementer agent inside a running execution: mark the current task done, or append a newly-discovered one.",
    usage: ["cctl workflow task <complete|add>"],
    flags: [],
    examples: [],
    related: [
      {
        command: "workflow collab request",
        oneLiner: "get a second opinion instead of guessing at a fork",
      },
    ],
  },
  {
    path: ["workflow", "task", "complete"],
    dynamicContext: true,
    summary: "mark the current lane task done (advances the workflow)",
    description: `Mark the current task done — call this after each task; it is the only way the workflow advances. <taskId> is the task's id/slug from the task list; --summary records what you changed and how you verified it. On success it hints how many tasks remain. A server stop instruction (mid-turn rotation, "CONTEXT LIMIT REACHED …") prints as primary output instead of the remaining-count hint — obey it and end your turn. ${LANE_NOTE}`,
    usage: [
      'cctl workflow task complete <taskId> --summary "<what changed, how verified>"',
    ],
    flags: [
      {
        name: "summary",
        kind: "value",
        valuePlaceholder: '"<what changed, how verified>"',
        description: "what you changed and how you verified it",
      },
    ],
    examples: [
      {
        invocation:
          'cctl workflow task complete implement-auth --summary "Added OAuth2 route + tests; bun test green"',
        explanation:
          "call after EACH task — it is the only way the workflow advances; a CONTEXT LIMIT stop instruction means end your turn",
      },
    ],
    related: [
      {
        command: "workflow task add",
        oneLiner: "append a task you discovered mid-execution",
      },
      {
        command: "workflow collab request",
        oneLiner: "escalate a genuinely ambiguous decision instead of guessing",
      },
    ],
  },
  {
    path: ["workflow", "task", "add"],
    dynamicContext: true,
    summary: "append a newly-discovered task to this lane",
    description: `Append a newly-discovered task to this context. Only allowed when the context enables agent-added tasks; if it does not, it exits 1 with the reason. --instructions must be self-contained for the agent that runs it. No hint. ${LANE_NOTE}`,
    usage: [
      'cctl workflow task add --title "<name>" --instructions "<self-contained steps>" [--slug <slug>]',
    ],
    flags: [
      {
        name: "title",
        kind: "value",
        valuePlaceholder: '"<name>"',
        description: "short task name",
      },
      {
        name: "instructions",
        kind: "value",
        valuePlaceholder: '"<self-contained steps>"',
        description: "self-contained instructions for the agent that runs it",
      },
      {
        name: "slug",
        kind: "value",
        valuePlaceholder: "<slug>",
        description: "optional kebab-case id (auto-generated from the title)",
      },
    ],
    examples: [
      {
        invocation:
          'cctl workflow task add --title "Handle token refresh" --instructions "Add refresh-token rotation to /api/auth; cover expiry in tests."',
        explanation:
          "--instructions must stand alone — the running agent has none of your current context",
      },
    ],
    related: [
      {
        command: "workflow task complete",
        oneLiner: "complete the current task to advance",
      },
    ],
  },
  {
    path: ["workflow", "graph"],
    dynamicContext: true,
    summary: "grow the running graph from inside a lane",
    description:
      "Lane verb family for runtime graph expansion: append new execution contexts, their tasks, and the edges wiring them in — without pausing the execution.",
    usage: ["cctl workflow graph expand --file .cc/temp/expansion.json"],
    flags: [],
    examples: [],
    related: [
      {
        command: "workflow task add",
        oneLiner: "append work to THIS context instead of creating new ones",
      },
    ],
  },
  {
    path: ["workflow", "graph", "expand"],
    dynamicContext: true,
    summary: "append new contexts, tasks, and edges to the running graph",
    description: `Append a bounded subgraph to the RUNNING execution. Only allowed when your context enables agent graph expansion; if it does not, it exits 1 with the reason. --file is a JSON object { requestId, rationale, contexts[], tasks[], edges[] }: each context has a kebab-case "handle" (your local name) plus title and acceptanceCriteria; each task names the "contextHandle" it belongs to; each edge's "from" is your own context id or a handle, and its "to" is a handle or a pre-declared downstream context to rejoin. The server mints the real ids and returns them. A context may also carry "configFromContextId" (an EXISTING context to seed its implementer, iterationPolicy, circuitBreaker, and scriptValidator from — never a handle in this same request) and "config" with overrides for those same four blocks; everything else (context validator, approval gate, questions, collaboration, plan repair, mutability) is inherited from YOUR context and cannot be overridden, and a scriptValidator override may only enable it. All-or-nothing — one envelope violation refuses the whole request. ${EXPANSION_CAPS_NOTE} Reuse a requestId only to retry the identical payload: an accepted request replays its receipt (nothing fans out twice), while the SAME id carrying a changed payload is refused. ${LANE_NOTE}`,
    usage: ["cctl workflow graph expand --file .cc/temp/expansion.json"],
    flags: [
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<expansion.json>",
        description:
          "JSON object { requestId, rationale, contexts[], tasks[], edges[] }",
      },
    ],
    examples: [
      {
        invocation: "cctl workflow graph expand --file .cc/temp/expansion.json",
        explanation:
          "fan out one context per candidate, each rejoining the filter context the planner already declared",
      },
    ],
    related: [
      {
        command: "workflow live get",
        oneLiner: "read the current graph before deciding what to add",
      },
      {
        command: "workflow task complete",
        oneLiner: "advance your own lane after expanding",
      },
    ],
  },
  {
    path: ["workflow", "shared-doc"],
    dynamicContext: true,
    summary: "share a document with other lanes",
    description:
      "Register (or update) a shared document other lanes in the execution will read.",
    usage: [
      "cctl workflow shared-doc upsert <relativePath> --file .cc/temp/doc.json",
    ],
    flags: [],
    examples: [],
    related: [
      {
        command: "workflow task complete",
        oneLiner: "advance the lane after sharing the document",
      },
    ],
  },
  {
    path: ["workflow", "shared-doc", "upsert"],
    dynamicContext: true,
    summary: "register or update a shared document for other lanes",
    description: `Register (or update) a shared document other lanes will read. <relativePath> is the doc's path in the worktree (e.g. .cc/graph-workflow-docs/api-contract.md); --file .cc/temp/doc.json is a JSON object { "description": "…", "readWhen": "…" } (author it with the Write tool — both fields are prose). No hint. ${LANE_NOTE}`,
    usage: [
      "cctl workflow shared-doc upsert <relativePath> --file .cc/temp/doc.json",
    ],
    flags: [
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<doc.json>",
        description: 'JSON object { "description": "…", "readWhen": "…" }',
      },
    ],
    examples: [
      {
        invocation:
          "cctl workflow shared-doc upsert .cc/graph-workflow-docs/api-contract.md --file .cc/temp/doc.json",
        explanation:
          'the payload is { "description": "…", "readWhen": "…" }; <relativePath> is where the doc lives in the worktree',
      },
    ],
    related: [
      {
        command: "workflow task complete",
        oneLiner: "advance the lane after registering the document",
      },
    ],
  },
  {
    path: ["workflow", "collab"],
    dynamicContext: true,
    summary: "request a second opinion from another agent",
    description:
      "Request a structured second opinion from another agent on a genuinely ambiguous, high-impact decision.",
    usage: ['cctl workflow collab request --brief "<question with context>"'],
    flags: [],
    examples: [],
    related: [
      {
        command: "workflow task complete",
        oneLiner: "advance the lane when you can decide yourself",
      },
    ],
  },
  {
    path: ["workflow", "collab", "request"],
    dynamicContext: true,
    summary: "ask another agent to weigh in on an ambiguous decision",
    description: `Request a structured second opinion on a genuinely ambiguous, high-impact decision. --brief states the problem and the context — do NOT include your preferred solution. The collaboration runs in the BACKGROUND: the command returns immediately with a workflow id — STOP work on this turn and wait for the follow-up that delivers the outcome. Only allowed when the context enables collaboration; otherwise exits 1. ${LANE_NOTE}`,
    usage: ['cctl workflow collab request --brief "<question with context>"'],
    flags: [
      {
        name: "brief",
        kind: "value",
        valuePlaceholder: '"<question with context>"',
        description: "the problem + context, WITHOUT your preferred solution",
      },
    ],
    examples: [
      {
        invocation:
          'cctl workflow collab request --brief "Store sessions in SQLite or Redis? Constraints: single-node, <10k sessions, must survive restart."',
        explanation:
          "returns a workflow id and runs in the background — stop and wait for the outcome; do not state your own preference in the brief",
      },
    ],
    related: [
      {
        command: "workflow task complete",
        oneLiner: "advance the lane once the decision is settled",
      },
    ],
  },
];
