import { bytes, defineGroup } from "cli-for-agents";
import { ccCommands } from "../../framework/family";
const definitionId = {
  name: "definition-id",
  description: "Saved workflow definition id",
  value: { kind: "string", minLength: 1 },
} as const;
const executionId = {
  name: "execution-id",
  description: "Durable workflow execution id",
  value: { kind: "string", minLength: 1 },
} as const;
const taskId = {
  name: "task-id",
  description: "Task id in the current context",
  value: { kind: "string", minLength: 1 },
} as const;
const relativePath = {
  name: "relative-path",
  description: "Document path relative to the worktree",
  value: { kind: "string", minLength: 1 },
} as const;
const optionalId = {
  description: "Addressed identifier",
  value: { kind: "string", minLength: 1 },
} as const;
const booleanFlag = {
  description: "Select this option",
  value: { kind: "boolean" },
} as const;
const tier = {
  description: "Workflow library tier",
  value: { kind: "enum", values: ["global", "project"] },
  default: "project",
} as const;
const prose = {
  description: "Complete prose content",
  value: { kind: "string" },
  fileSource: { maxBytes: bytes(262_144) },
} as const;
const inputFile = {
  description: "JSON input bindings file",
  value: { kind: "file", maxBytes: bytes(262_144) },
} as const;
const duration = {
  description: "Client wait budget (default 30m)",
  value: {
    kind: "pattern",
    pattern: "^\\d+(ms|s|m|h)?$",
    description: "Duration such as 30m or 90s",
  },
} as const;
export const validateSpec = {
  path: "workflow validate",
  summary: "Validate a plan without saving",
  description:
    "Run the authoritative create-path validation. Managed draft findings are grouped by propose and signoff gates; warnings and preflight findings do not change a successful validation verdict.",
  requires: "cc",
  effects: "read",
  args: [],
  flags: { tier, definition: optionalId },
  payload: { maxBytes: bytes(1_048_576) },
} as const;
export const validateCommand = ccCommands.defineCommand(validateSpec, {
  examples: [
    { file: ".cc/temp/plan.json", why: "Validate a plan without saving" },
  ],
  handler: async () => ({
    default: (await import("./authoring")).validateHandler,
  }),
});
export const createSpec = {
  path: "workflow create",
  summary: "Save a new workflow definition",
  description:
    "Save a complete plan for visual review. Review acknowledgement names the exact content hash.",
  requires: "cc",
  effects: "write",
  args: [],
  flags: { "acknowledge-review": optionalId },
  payload: {
    maxBytes: bytes(1_048_576),
    validatePath: "workflow create-check",
  },
} as const;
export const createCommand = ccCommands.defineCommand(createSpec, {
  examples: [
    { file: ".cc/temp/plan.json", why: "Save a new workflow definition" },
  ],
  handler: async () => ({
    default: (await import("./authoring")).createHandler,
  }),
});
export const replaceSpec = {
  path: "workflow replace",
  summary: "Replace a saved workflow definition",
  description:
    "Submit the complete plan and expectedRevision from workflow get. Managed draft server-owned regions are filled from the stored definition; stale revisions and locked regions are refused.",
  requires: "cc",
  effects: "write",
  args: [definitionId],
  flags: { "acknowledge-review": optionalId },
  payload: {
    maxBytes: bytes(1_048_576),
    validatePath: "workflow replace-check",
  },
} as const;
export const replaceCommand = ccCommands.defineCommand(replaceSpec, {
  examples: [
    {
      file: ".cc/temp/plan.json",
      args: { "definition-id": "workflow-one" },
      why: "Replace a saved workflow definition",
    },
  ],
  handler: async () => ({
    default: (await import("./authoring")).replaceHandler,
  }),
});
export const reviewGetSpec = {
  path: "workflow review get",
  summary: "Read the review of exact plan content",
  description:
    "The server hashes the plan. Read the complete findings and reviewer conversation references; an unreviewed plan remains valid.",
  requires: "cc",
  effects: "read",
  args: [],
  flags: {},
  payload: { maxBytes: bytes(1_048_576) },
} as const;
export const reviewGetCommand = ccCommands.defineCommand(reviewGetSpec, {
  examples: [
    {
      file: ".cc/temp/plan.json",
      why: "Read the review of exact plan content",
    },
  ],
  handler: async () => ({
    default: (await import("./authoring")).reviewGetHandler,
  }),
});
export const reviewRecordSpec = {
  path: "workflow review record",
  summary: "Record an advisory plan review",
  description:
    "Record a terminal review bound to the exact content hash. Changes-requested requires nonempty findings. Reviewer identity defaults to the issuing conversation.",
  requires: "cc",
  effects: "write",
  args: [],
  flags: {
    verdict: {
      description: "Terminal review verdict",
      value: { kind: "enum", values: ["approved", "changes-requested"] },
      required: true,
    },
    findings: prose,
    reviewer: optionalId,
  },
  payload: {
    maxBytes: bytes(1_048_576),
    validatePath: "workflow review record-check",
  },
} as const;
export const reviewRecordCommand = ccCommands.defineCommand(reviewRecordSpec, {
  examples: [
    {
      file: ".cc/temp/plan.json",
      flags: { verdict: "approved" },
      why: "Record an advisory plan review",
    },
  ],
  handler: async () => ({
    default: (await import("./authoring")).reviewRecordHandler,
  }),
});
export const listSpec = {
  path: "workflow list",
  summary: "List saved workflow definitions",
  description: "List project definitions with revision handles.",
  requires: "cc",
  effects: "read",
  args: [],
  flags: {},
} as const;
export const listCommand = ccCommands.defineCommand(listSpec, {
  examples: [{ why: "List saved workflow definitions" }],
  handler: async () => ({ default: (await import("./reads")).listHandler }),
});
export const getSpec = {
  path: "workflow get",
  summary: "Read a workflow outline or addressed section",
  description:
    "The default outline shows edit handles and prose sizes. Choose one section selector, or --full for the full definition. expectedRevision is the token for the next edit. Global templates use --tier global.",
  requires: "cc",
  effects: "read",
  args: [definitionId],
  flags: {
    tier,
    context: optionalId,
    task: optionalId,
    charter: booleanFlag,
    config: booleanFlag,
    params: booleanFlag,
  },
  levels: { full: { output: "artifact-eligible" } },
} as const;
export const getCommand = ccCommands.defineCommand(getSpec, {
  examples: [
    {
      args: { "definition-id": "workflow-one" },
      why: "Read a workflow outline or addressed section",
    },
  ],
  handler: async () => ({ default: (await import("./reads")).getHandler }),
});
export const editSpec = {
  path: "workflow edit",
  summary: "Apply atomic definition edits",
  description:
    "Submit expectedRevision and operations. The preview runs the server dry-run, returns the unchanged revision, and preserves authoritative findings. Local edit-check validates input and context only.",
  requires: "cc",
  effects: "write",
  args: [definitionId],
  flags: { tier },
  payload: { maxBytes: bytes(1_048_576), validatePath: "workflow edit-check" },
} as const;
export const editCommand = ccCommands.defineCommand(editSpec, {
  examples: [
    {
      file: ".cc/temp/ops.json",
      args: { "definition-id": "workflow-one" },
      why: "Apply atomic definition edits",
    },
  ],
  handler: async () => ({ default: (await import("./authoring")).editHandler }),
});
export const editPreviewSpec = {
  path: "workflow edit-preview",
  summary: "Preview definition edits",
  description:
    "Submit expectedRevision and operations. The preview runs the server dry-run, returns the unchanged revision, and preserves authoritative findings. Local edit-check validates input and context only.",
  requires: "cc",
  effects: "read",
  args: [definitionId],
  flags: { tier },
  payload: { maxBytes: bytes(1_048_576) },
} as const;
export const editPreviewCommand = ccCommands.defineCommand(editPreviewSpec, {
  examples: [
    {
      file: ".cc/temp/ops.json",
      args: { "definition-id": "workflow-one" },
      why: "Preview definition edits",
    },
  ],
  handler: async () => ({
    default: (await import("./authoring")).editPreviewHandler,
  }),
});
export const statusSpec = {
  path: "workflow status",
  summary: "Read execution status",
  description:
    "Read the active execution or a specified historical execution. --halt exposes the structured halt and repair rounds; --full exposes the entire execution.",
  requires: "cc",
  effects: "read",
  args: [{ ...executionId, required: false }],
  flags: { halt: booleanFlag },
  levels: { full: { output: "artifact-eligible" } },
} as const;
export const statusCommand = ccCommands.defineCommand(statusSpec, {
  examples: [{ why: "Read execution status" }],
  handler: async () => ({ default: (await import("./reads")).statusHandler }),
});
export const startSpec = {
  path: "workflow start",
  summary: "Launch a saved workflow",
  description:
    "Launch with optional JSON parameter bindings from --inputs. A parked launch still owns a durable execution receipt; the user approves the pending definition.",
  requires: "cc",
  effects: "write",
  args: [definitionId],
  flags: { inputs: inputFile },
} as const;
export const startCommand = ccCommands.defineCommand(startSpec, {
  examples: [
    {
      args: { "definition-id": "workflow-one" },
      why: "Launch a saved workflow",
    },
  ],
  handler: async () => ({
    default: (await import("./lifecycle")).startHandler,
  }),
});
export const runSpec = {
  path: "workflow run",
  summary: "Launch a one-off authored workflow",
  description:
    "Launch a plan without saving a definition. Optional --inputs supplies parameter bindings. --wait observes the next durable boundary; timeout or interruption leaves the execution available to workflow wait.",
  requires: "cc",
  effects: "write",
  args: [],
  flags: { inputs: inputFile, wait: booleanFlag, timeout: duration },
  payload: { maxBytes: bytes(1_048_576), validatePath: "workflow run-check" },
} as const;
export const runCommand = ccCommands.defineCommand(runSpec, {
  examples: [
    { file: ".cc/temp/plan.json", why: "Launch a one-off authored workflow" },
  ],
  handler: async () => ({ default: (await import("./lifecycle")).runHandler }),
});
export const waitSpec = {
  path: "workflow wait",
  summary: "Wait for an execution boundary",
  description:
    "Read the first durable boundary after the cursor. Timeout, disconnect, and interruption stop observation without cancelling the execution. Reattach with the same execution id and cursor.",
  requires: "cc",
  effects: "read",
  args: [executionId],
  flags: { cursor: optionalId, timeout: { ...duration, default: "30m" } },
} as const;
export const waitCommand = ccCommands.defineCommand(waitSpec, {
  examples: [
    {
      args: { "execution-id": "execution-one" },
      why: "Wait for an execution boundary",
    },
  ],
  handler: async () => ({ default: (await import("./lifecycle")).waitHandler }),
});
export const abandonSpec = {
  path: "workflow abandon",
  summary: "Abandon a halted execution",
  description:
    "Audit the reason, release the lease, and move the addressed halted execution to History.",
  requires: "cc",
  effects: "write",
  args: [executionId],
  flags: { reason: { ...prose, required: true } },
} as const;
export const abandonCommand = ccCommands.defineCommand(abandonSpec, {
  examples: [
    {
      args: { "execution-id": "execution-one" },
      flags: { reason: "Superseded by a corrected plan" },
      why: "Abandon a halted execution",
    },
  ],
  handler: async () => ({
    default: (await import("./lifecycle")).abandonHandler,
  }),
});
export const deleteSpec = {
  path: "workflow delete",
  summary: "Delete a saved workflow definition",
  description: "Delete the addressed saved definition.",
  requires: "cc",
  effects: "write",
  args: [definitionId],
  flags: {},
} as const;
export const deleteCommand = ccCommands.defineCommand(deleteSpec, {
  examples: [
    {
      args: { "definition-id": "workflow-one" },
      why: "Delete a saved workflow definition",
    },
  ],
  handler: async () => ({
    default: (await import("./authoring")).deleteHandler,
  }),
});
export const templatesSpec = {
  path: "workflow templates",
  summary: "List reusable workflow templates",
  description:
    "Read global and project template metadata; optionally filter one tier.",
  requires: "cc",
  effects: "read",
  args: [],
  flags: {
    tier: {
      description: "Optional workflow library tier",
      value: { kind: "enum", values: ["global", "project"] },
    },
  },
} as const;
export const templatesCommand = ccCommands.defineCommand(templatesSpec, {
  examples: [{ why: "List reusable workflow templates" }],
  handler: async () => ({
    default: (await import("./reads")).templatesHandler,
  }),
});
export const liveGetSpec = {
  path: "workflow live get",
  summary: "Read the live execution edit map",
  description:
    "Read liveRevision and exact edit handles. Choose one context, task, resolved config, charter, or outputs section. --full returns the whole live definition.",
  requires: "cc",
  effects: "read",
  args: [],
  flags: {
    context: optionalId,
    task: optionalId,
    config: optionalId,
    charter: booleanFlag,
    outputs: booleanFlag,
  },
  levels: { full: { output: "artifact-eligible" } },
} as const;
export const liveGetCommand = ccCommands.defineCommand(liveGetSpec, {
  examples: [{ why: "Read the live execution edit map" }],
  handler: async () => ({ default: (await import("./reads")).liveGetHandler }),
});
export const liveLedgerSpec = {
  path: "workflow live ledger",
  summary: "Read loop decision history",
  description:
    "Walk durable decision events in ascending order. --max-pages bounds the walk and returns its resume cursor; omitted pages never appear complete.",
  requires: "cc",
  effects: "read",
  args: [],
  flags: {
    cursor: {
      description: "Starting event sequence",
      value: { kind: "integer", min: 0 },
    },
    "max-pages": {
      description: "Maximum event pages",
      value: { kind: "integer", min: 1 },
    },
  },
} as const;
export const liveLedgerCommand = ccCommands.defineCommand(liveLedgerSpec, {
  examples: [{ why: "Read loop decision history" }],
  handler: async () => ({
    default: (await import("./reads")).liveLedgerHandler,
  }),
});
export const liveEditSpec = {
  path: "workflow live edit",
  summary: "Apply atomic live edits",
  description:
    "Submit executionId, baseLiveRevision, and operations. The server enforces pause, frozen regions, and expected parent hashes. The preview applies no changes and returns full dry-run findings.",
  requires: "cc",
  effects: "write",
  args: [],
  flags: {},
  payload: {
    maxBytes: bytes(1_048_576),
    validatePath: "workflow live edit-check",
  },
} as const;
export const liveEditCommand = ccCommands.defineCommand(liveEditSpec, {
  examples: [
    { file: ".cc/temp/live-ops.json", why: "Apply atomic live edits" },
  ],
  handler: async () => ({
    default: (await import("./authoring")).liveEditHandler,
  }),
});
export const liveEditPreviewSpec = {
  path: "workflow live edit-preview",
  summary: "Preview live edits",
  description:
    "Submit executionId, baseLiveRevision, and operations. The server enforces pause, frozen regions, and expected parent hashes. The preview applies no changes and returns full dry-run findings.",
  requires: "cc",
  effects: "read",
  args: [],
  flags: {},
  payload: { maxBytes: bytes(1_048_576) },
} as const;
export const liveEditPreviewCommand = ccCommands.defineCommand(
  liveEditPreviewSpec,
  {
    examples: [{ file: ".cc/temp/live-ops.json", why: "Preview live edits" }],
    handler: async () => ({
      default: (await import("./authoring")).liveEditPreviewHandler,
    }),
  },
);
export const liveAmendSpec = {
  path: "workflow live amend",
  summary: "Amend a launched delivery plan",
  description:
    "Add contexts, tasks, or edges through the audited amendment endpoint. The reason and prior/new working-definition hashes remain in the durable receipt.",
  requires: "cc",
  effects: "write",
  args: [],
  flags: { reason: { ...prose, required: true } },
  payload: {
    maxBytes: bytes(1_048_576),
    validatePath: "workflow live amend-check",
  },
} as const;
export const liveAmendCommand = ccCommands.defineCommand(liveAmendSpec, {
  examples: [
    {
      file: ".cc/temp/live-ops.json",
      flags: { reason: "Add a verification context" },
      why: "Amend a launched delivery plan",
    },
  ],
  handler: async () => ({
    default: (await import("./authoring")).liveAmendHandler,
  }),
});
export const livePauseSpec = {
  path: "workflow live pause",
  summary: "Pause the active execution",
  description:
    "The server checks the issuing principal independently from target flags and returns the authoritative lifecycle receipt.",
  requires: "cc",
  effects: "write",
  args: [],
  flags: {},
} as const;
export const livePauseCommand = ccCommands.defineCommand(livePauseSpec, {
  examples: [{ why: "Pause the active execution" }],
  handler: async () => ({
    default: (await import("./lifecycle")).livePauseHandler,
  }),
});
export const liveResumeSpec = {
  path: "workflow live resume",
  summary: "Resume the active execution",
  description:
    "The server checks the issuing principal independently from target flags and returns the authoritative lifecycle receipt.",
  requires: "cc",
  effects: "write",
  args: [],
  flags: {},
} as const;
export const liveResumeCommand = ccCommands.defineCommand(liveResumeSpec, {
  examples: [{ why: "Resume the active execution" }],
  handler: async () => ({
    default: (await import("./lifecycle")).liveResumeHandler,
  }),
});
export const liveAbortSpec = {
  path: "workflow live abort",
  summary: "Abort the active execution",
  description:
    "The server checks the issuing principal independently from target flags and returns the authoritative lifecycle receipt.",
  requires: "cc",
  effects: "write",
  args: [],
  flags: { reason: { ...prose, required: true } },
} as const;
export const liveAbortCommand = ccCommands.defineCommand(liveAbortSpec, {
  examples: [
    {
      flags: { reason: "Superseded by a corrected plan" },
      why: "Abort the active execution",
    },
  ],
  handler: async () => ({
    default: (await import("./lifecycle")).liveAbortHandler,
  }),
});
export const taskCompleteSpec = {
  path: "workflow task complete",
  summary: "Complete the current lane task",
  description:
    "Report changes and verification after each task. Server stop instructions require ending the turn immediately; remainingTaskCount is authoritative.",
  requires: "cc",
  effects: "write",
  args: [taskId],
  flags: { summary: { ...prose, required: true } },
} as const;
export const taskCompleteCommand = ccCommands.defineCommand(taskCompleteSpec, {
  examples: [
    {
      args: { "task-id": "implement" },
      flags: { summary: "Implemented and verified the change" },
      why: "Complete the current lane task",
    },
  ],
  handler: async () => ({
    default: (await import("./lane")).taskCompleteHandler,
  }),
});
export const taskAddSpec = {
  path: "workflow task add",
  summary: "Add a task to the current lane",
  description:
    "Submit self-contained instructions. Lane identity comes from injected execution/context variables; policy is server-owned.",
  requires: "cc",
  effects: "write",
  args: [],
  flags: {
    title: { ...optionalId, required: true },
    instructions: { ...prose, required: true },
    slug: optionalId,
  },
} as const;
export const taskAddCommand = ccCommands.defineCommand(taskAddSpec, {
  examples: [
    {
      flags: {
        title: "Verify behavior",
        instructions: "Run the registered scoped check",
      },
      why: "Add a task to the current lane",
    },
  ],
  handler: async () => ({ default: (await import("./lane")).taskAddHandler }),
});
export const graphExpandSpec = {
  path: "workflow graph expand",
  summary: "Expand the graph from this lane",
  description:
    "Submit requestId, contexts, and tasks under the lane expansion capability. A replay returns the prior receipt; it does not schedule duplicate children.",
  requires: "cc",
  effects: "write",
  args: [],
  flags: {},
  payload: {
    maxBytes: bytes(1_048_576),
    validatePath: "workflow graph expand-check",
  },
} as const;
export const graphExpandCommand = ccCommands.defineCommand(graphExpandSpec, {
  examples: [
    { file: ".cc/temp/expansion.json", why: "Expand the graph from this lane" },
  ],
  handler: async () => ({
    default: (await import("./lane")).graphExpandHandler,
  }),
});
export const sharedDocUpsertSpec = {
  path: "workflow shared-doc upsert",
  summary: "Register a shared lane document",
  description:
    "Register description and readWhen for the existing worktree-relative document. The server owns shared document revision and publication.",
  requires: "cc",
  effects: "write",
  args: [relativePath],
  flags: {},
  payload: {
    maxBytes: bytes(1_048_576),
    validatePath: "workflow shared-doc upsert-check",
  },
} as const;
export const sharedDocUpsertCommand = ccCommands.defineCommand(
  sharedDocUpsertSpec,
  {
    examples: [
      {
        args: { "relative-path": ".cc/workflow-docs/contract.md" },
        file: ".cc/temp/doc.json",
        why: "Register a shared lane document",
      },
    ],
    handler: async () => ({
      default: (await import("./lane")).sharedDocUpsertHandler,
    }),
  },
);
export const collabRequestSpec = {
  path: "workflow collab request",
  summary: "Request lane collaboration",
  description:
    "Describe the question and constraints. Collaboration runs in the background; after its receipt, end the turn and wait for the delivered outcome.",
  requires: "cc",
  effects: "write",
  args: [],
  flags: { brief: { ...prose, required: true } },
} as const;
export const collabRequestCommand = ccCommands.defineCommand(
  collabRequestSpec,
  {
    examples: [
      {
        flags: {
          brief: "Review the interface constraints and recommend a direction",
        },
        why: "Request lane collaboration",
      },
    ],
    handler: async () => ({
      default: (await import("./lane")).collabRequestHandler,
    }),
  },
);
export const workflowCommands = [
  validateCommand,
  createCommand,
  replaceCommand,
  reviewGetCommand,
  reviewRecordCommand,
  listCommand,
  getCommand,
  editCommand,
  editPreviewCommand,
  statusCommand,
  startCommand,
  runCommand,
  waitCommand,
  abandonCommand,
  deleteCommand,
  templatesCommand,
  liveGetCommand,
  liveLedgerCommand,
  liveEditCommand,
  liveEditPreviewCommand,
  liveAmendCommand,
  livePauseCommand,
  liveResumeCommand,
  liveAbortCommand,
  taskCompleteCommand,
  taskAddCommand,
  graphExpandCommand,
  sharedDocUpsertCommand,
  collabRequestCommand,
] as const;
export const workflowGroups = [
  defineGroup({
    path: "workflow",
    summary: "Author and operate workflows",
    description:
      "Author and operate workflows. Server policy and injected principal identity govern mutations.",
  }),
  defineGroup({
    path: "workflow review",
    summary: "Read and record content-bound plan reviews",
    description:
      "Read and record content-bound plan reviews. Server policy and injected principal identity govern mutations.",
  }),
  defineGroup({
    path: "workflow live",
    summary: "Inspect and change the active execution",
    description:
      "Inspect and change the active execution. Server policy and injected principal identity govern mutations.",
  }),
  defineGroup({
    path: "workflow task",
    summary: "Transition current lane tasks",
    description:
      "Transition current lane tasks. Server policy and injected principal identity govern mutations.",
  }),
  defineGroup({
    path: "workflow graph",
    summary: "Expand this lane graph",
    description:
      "Expand this lane graph. Server policy and injected principal identity govern mutations.",
  }),
  defineGroup({
    path: "workflow shared-doc",
    summary: "Publish lane shared documents",
    description:
      "Publish lane shared documents. Server policy and injected principal identity govern mutations.",
  }),
  defineGroup({
    path: "workflow collab",
    summary: "Request lane collaboration",
    description:
      "Request lane collaboration. Server policy and injected principal identity govern mutations.",
  }),
] as const;
