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

export const workflowHelpEntries: CommandHelpEntry[] = [
  {
    path: ["workflow"],
    dynamicContext: true,
    summary: "list, inspect, start, and delete graph workflows",
    description:
      "Author, read, launch, and inspect graph workflows — saved multi-context task graphs and their live executions. Authoring walks the canonical chain validate → create → start. The lane verbs (task complete/add, shared-doc upsert, collab request) are a SEPARATE family for the implementer agent inside a running execution.",
    usage: [
      "cctl workflow <validate|create|replace|list|get|status|start|delete|templates>",
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
      "Check a plan.json against the EXACT create-path rules (the create Zod parse plus graph structural checks: dependency cycles, unknown context refs, prerequisite sanity) without saving. On issues it exits 2 and prints one issue per line with its JSON path (e.g. definition.tasks.2.contextId: …) — fix the file and re-run. Session-scoped.",
    usage: ["cctl workflow validate --file .cc/temp/plan.json [--json]"],
    flags: [
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<plan.json>",
        description: "the plan authored per the graph-workflow-planning skill",
      },
    ],
    examples: [
      {
        invocation: "cctl workflow validate --file .cc/temp/plan.json",
        explanation:
          "always validate first — exit 2 lists issues one per line with their JSON path; on success it hints the create command",
      },
    ],
    related: [
      {
        command: "workflow create",
        oneLiner: "save the validated plan as a new definition",
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
      "Overwrite an existing definition (<id>) with a plan.json — submit the COMPLETE graph, not a diff (the previous definition is fully overwritten). Re-validate first. No hint — a revision is not a step in the author-then-start chain.",
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
          "fully overwrites wf-1 — `cctl workflow get wf-1` first, edit the whole graph, re-validate, then replace",
      },
    ],
    related: [
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
    summary: "print a saved definition's full JSON",
    description:
      "Print a saved definition's full JSON, for inspection before a `cctl workflow replace`. An unknown id exits 2. No hint.",
    usage: ["cctl workflow get <id> [--json]"],
    flags: [],
    examples: [
      {
        invocation: "cctl workflow get wf-1",
        explanation:
          "the id comes from `cctl workflow list`; pipe this into a file to edit for a `replace`",
      },
    ],
    related: [
      { command: "workflow list", oneLiner: "find the id to inspect" },
      {
        command: "workflow replace",
        oneLiner: "overwrite the definition after editing it",
      },
    ],
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
