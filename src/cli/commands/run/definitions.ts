import { bytes, defineGroup } from "cli-for-agents";
import type { AllowanceKind, HaltDisposition } from "@/lib/execution-context/schemas";
import { ccCommands } from "../../framework/family";

/**
 * The dispositions and allowances a Context accepts. Literal, as flag types
 * need them; the checks below fail to compile when they and Context's schemas
 * differ in either direction.
 */
const DISPOSITION_KINDS = [
  "continue",
  "retry",
  "retry_capture",
  "retry_advice",
  "replace_seat",
  "rereview",
  "grant",
  "confirm_effect",
] as const satisfies readonly HaltDisposition["kind"][];
const ALLOWANCE_KINDS = ["unfinishedTaskRetries", "validationRetries"] as const satisfies readonly AllowanceKind[];
const everyDispositionListed: Exclude<HaltDisposition["kind"], (typeof DISPOSITION_KINDS)[number]> extends never
  ? true
  : never = true;
const everyAllowanceListed: Exclude<AllowanceKind, (typeof ALLOWANCE_KINDS)[number]> extends never ? true : never = true;
void everyDispositionListed;
void everyAllowanceListed;

const runId = {
  name: "run-id",
  description: "Run id from its launch receipt or a run-boundary notice",
  value: { kind: "string", minLength: 1 },
} as const;
const taskId = {
  name: "task-id",
  description: "Task id from your context's task list",
  value: { kind: "string", minLength: 1 },
} as const;

export const runLaunchSpec = {
  path: "run launch",
  summary: "Launch a supervised agent run in this session",
  description:
    "Start an agent that works in the session worktree under supervision. The file needs only a brief; tasks, checks, reviewers, output schema and approval are opt-in. You own the run: its questions, halts and result arrive as run-boundary messages.",
  requires: "cc",
  effects: "write",
  args: [],
  flags: {},
  payload: { maxBytes: bytes(262_144), validatePath: "run launch-check" },
} as const;
export const runWorkflowSpec = {
  path: "run workflow",
  summary: "Launch a supervised workflow of several contexts in this session",
  description:
    "Start several supervised contexts in the session worktree. Each context takes the same fields as run launch plus a key, an optional dependsOn list and an optional write scope; a context starts once every context it depends on succeeded, with their accepted results as its inputs. A dependsOn entry may be {key, when}: when is {schema} (a JSON-Schema subset the dependency's accepted output must match; the dependency needs an outputSchema) or {else: true} (taken when no guarded sibling matched); a context whose route is not taken is skipped, and routing {cardinality: atLeastOne|exactlyOne} on the source halts the run when its result takes the wrong number of routes. A loop {key, body, entry, exit, until: {schema}, maxPasses} reruns its body in fresh contexts, the entry receiving the exit results of up to three recent passes, until the exit's output (it needs an outputSchema) matches until; only the entry may depend on work outside the loop, the body has no routes, and work after the loop depends on its exit and sees only the final pass. A context with lane: <key> works in an isolated lane: its own worktree and branch, started from the session branch's committed head, where each accepted result is committed; once all its contexts are done the lane is merged with the session head, checked (lanes: [{key, checks}]) and published into the session branch, and only then can work outside the lane use its code. A lane cannot use a session context's code (it is never committed): mark such a dependency {key, outputOnly: true} if only the result is needed. Contexts and lanes that would wait for each other are refused. A publication changes the session worktree, so each session context must be ordered against each lane's publication, or placed in a lane: a read-only one depends on the lane's work or the lane's work depends on it (outputOnly), and a writing one depends on the lane's work, since its uncommitted results block publication. Conflicts with the session head are resolved, and failing lane checks fixed, by agents in the lane before it publishes. Contexts that could run at the same time in one worktree need disjoint owned write scopes, a read-only context cannot run beside any writer there, and a whole-tree check of a context other writers run alongside needs a later context in the same worktree that depends on it, runs whenever it runs, and selects the same check, or, in a lane, the lane's checks. You own the run: its questions, halts and result arrive as run-boundary messages.",
  requires: "cc",
  effects: "write",
  args: [],
  flags: {},
  payload: { maxBytes: bytes(1_048_576), validatePath: "run workflow-check" },
} as const;
export const runAmendSpec = {
  path: "run amend",
  summary: "Replace a workflow run's definition with a corrected one",
  description:
    "Submit the whole definition in the run workflow shape, as it should be from now on (run definition prints the current one). Work that has not started may change, be added or be removed, as long as every route already decided stays decided. Started contexts and the body of a started loop stay exactly as they started and in the loop they started in; a route already taken or not taken stays so, and a context or lane a route skipped stays skipped (put new work in a new context or lane), so removing work can be refused when it would turn an else route the other way; a result that broke its routing's cardinality or could not be read may get new routes, which clears that halt; a started loop may only get a higher maxPasses, which runs another pass of an exhausted loop; and a lane that has been provisioned, or asked to be, keeps its contexts, checks and the lanes whose code it started from. --based-on names the definition revision you read (run show), so a definition changed since is refused. Each refused change is named.",
  requires: "cc",
  effects: "write",
  args: [runId],
  flags: {
    "based-on": {
      description: "Definition revision the amendment was made from, as run show reports it",
      value: { kind: "integer", min: 1 },
    },
  },
  payload: { maxBytes: bytes(1_048_576), validatePath: "run amend-check" },
} as const;
export const runDefinitionSpec = {
  path: "run definition",
  summary: "Read a workflow run's definition as written, to edit and amend",
  description:
    "Returns the workflow in the run workflow shape as its current revision was written, with that revision. Edit it and submit it with run amend --based-on <revision>.",
  requires: "cc",
  effects: "read",
  args: [runId],
  flags: {},
} as const;
export const runShowSpec = {
  path: "run show",
  summary: "Read a run's progress, contexts and boundaries",
  description:
    "Read the run's progress, each context's tasks, open questions, halt occurrence and result, and the boundary ledger.",
  requires: "cc",
  effects: "read",
  args: [runId],
  flags: {},
} as const;
export const runAnswerSpec = {
  path: "run answer",
  summary: "Answer a question an agent in your run asked",
  description:
    "Answer the open question by id. The asking agent continues its interrupted work with the answer.",
  requires: "cc",
  effects: "write",
  args: [runId],
  flags: {
    question: {
      description: "Question id from the run-boundary notice or run show",
      value: { kind: "string", minLength: 1 },
      required: true,
    },
    text: {
      description: "The answer",
      value: { kind: "string", minLength: 1 },
      required: true,
      fileSource: { maxBytes: bytes(65_536) },
    },
  },
} as const;
export const runPauseSpec = {
  path: "run pause",
  summary: "Pause a run you launched",
  description:
    "Nothing new starts; work already admitted finishes. Resume with run resume.",
  requires: "cc",
  effects: "write",
  args: [runId],
  flags: {},
} as const;
export const runResumeSpec = {
  path: "run resume",
  summary: "Resume a paused or halted run",
  description:
    "Resume the run. A halted context needs a disposition naming the halt occurrence shown by run show; a grant also names the allowance, count and reason.",
  requires: "cc",
  effects: "write",
  args: [runId],
  flags: {
    context: {
      description: "Context id whose halt the disposition clears",
      value: { kind: "string", minLength: 1 },
    },
    occurrence: {
      description:
        "Halt occurrence from run show; a stale occurrence is refused",
      value: { kind: "string", minLength: 1 },
    },
    disposition: {
      description: "How to clear the halt",
      value: {
        kind: "enum",
        values: DISPOSITION_KINDS,
      },
    },
    allowance: {
      description: "Allowance a grant adds to",
      value: { kind: "enum", values: ALLOWANCE_KINDS },
    },
    count: {
      description: "How many more attempts a grant allows",
      value: { kind: "integer", min: 1, max: 10 },
    },
    reason: {
      description: "Why a grant or rereview is justified",
      value: { kind: "string", minLength: 1, maxLength: 1000 },
    },
    evidence: {
      description:
        "What you checked to confirm an uncertain effect (confirm_effect)",
      value: { kind: "string", minLength: 1, maxLength: 2000 },
    },
  },
} as const;
export const runCancelSpec = {
  path: "run cancel",
  summary: "Cancel a run you launched",
  description:
    "Stops every context in the run; admitted turns are interrupted and their partial work kept.",
  requires: "cc",
  effects: "write",
  args: [runId],
  flags: {},
} as const;
export const runRetrySpec = {
  path: "run retry",
  summary: "Ask for a new attempt at a lane's publication or provisioning",
  description:
    "After fixing what stopped a lane (changes in the session worktree, a moved session head, a conflict or a failing publication check, or a failed provisioning), ask for a new attempt. A new publication merges the current session head into the lane and checks it again.",
  requires: "cc",
  effects: "write",
  args: [runId],
  flags: {
    lane: {
      description: "Lane key, as run show lists it",
      value: { kind: "string", minLength: 1 },
      required: true,
    },
  },
} as const;
export const contextTaskCompleteSpec = {
  path: "context task complete",
  summary: "Mark one of your context's tasks done",
  description:
    "For the agent working a supervised context: record that a task in your task list is done.",
  requires: "cc",
  effects: "write",
  args: [taskId],
  flags: {},
} as const;
export const contextTaskReopenSpec = {
  path: "context task reopen",
  summary: "Reopen one of your context's tasks",
  description:
    "For the agent working a supervised context: record that a task you completed is not done.",
  requires: "cc",
  effects: "write",
  args: [taskId],
  flags: {},
} as const;
export const contextTaskAddSpec = {
  path: "context task add",
  summary: "Add a task your context's work needs",
  description:
    "For the agent working a supervised context: add a task the list lacks, when the context allows it.",
  requires: "cc",
  effects: "write",
  args: [taskId],
  flags: {
    title: {
      description: "Task title",
      value: { kind: "string", minLength: 1, maxLength: 200 },
      required: true,
    },
    instructions: {
      description: "What finishing the task means",
      value: { kind: "string", minLength: 1 },
      fileSource: { maxBytes: bytes(65_536) },
    },
  },
} as const;

const handlers = async () => import("./handlers");

export const runLaunchCommand = ccCommands.defineCommand(runLaunchSpec, {
  examples: [
    { file: ".cc/temp/run.json", why: "Launch an agent from a brief" },
  ],
  handler: async () => ({ default: (await handlers()).launchHandler }),
});
export const runWorkflowCommand = ccCommands.defineCommand(runWorkflowSpec, {
  examples: [
    {
      file: ".cc/temp/workflow.json",
      why: "Launch contexts that build on each other's results",
    },
  ],
  handler: async () => ({ default: (await handlers()).workflowHandler }),
});
export const runAmendCommand = ccCommands.defineCommand(runAmendSpec, {
  examples: [
    {
      file: ".cc/temp/workflow.json",
      args: { "run-id": "run-1" },
      flags: { "based-on": 2 },
      why: "Give a halted route's result new routes",
    },
  ],
  handler: async () => ({ default: (await handlers()).amendHandler }),
});
export const runDefinitionCommand = ccCommands.defineCommand(runDefinitionSpec, {
  examples: [{ why: "Read the definition to amend it", args: { "run-id": "run-1" } }],
  handler: async () => ({ default: (await handlers()).definitionHandler }),
});
export const runShowCommand = ccCommands.defineCommand(runShowSpec, {
  examples: [{ why: "Read a run you launched", args: { "run-id": "run-1" } }],
  handler: async () => ({ default: (await handlers()).showHandler }),
});
export const runAnswerCommand = ccCommands.defineCommand(runAnswerSpec, {
  examples: [
    {
      why: "Answer the agent's question",
      args: { "run-id": "run-1" },
      flags: { question: "q-1", text: "Use notice.ts" },
    },
  ],
  handler: async () => ({ default: (await handlers()).answerHandler }),
});
export const runPauseCommand = ccCommands.defineCommand(runPauseSpec, {
  examples: [{ why: "Pause a run", args: { "run-id": "run-1" } }],
  handler: async () => ({ default: (await handlers()).pauseHandler }),
});
export const runResumeCommand = ccCommands.defineCommand(runResumeSpec, {
  examples: [
    { why: "Resume a paused run", args: { "run-id": "run-1" } },
    {
      why: "Continue past a failed turn",
      args: { "run-id": "run-1" },
      flags: {
        context: "run-1.agent",
        occurrence: "occ-1",
        disposition: "continue",
      },
    },
  ],
  handler: async () => ({ default: (await handlers()).resumeHandler }),
});
export const runCancelCommand = ccCommands.defineCommand(runCancelSpec, {
  examples: [{ why: "Cancel a run", args: { "run-id": "run-1" } }],
  handler: async () => ({ default: (await handlers()).cancelHandler }),
});
export const runRetryCommand = ccCommands.defineCommand(runRetrySpec, {
  examples: [
    { why: "Publish a lane again after committing session changes", args: { "run-id": "run-1" }, flags: { lane: "api" } },
  ],
  handler: async () => ({ default: (await handlers()).retryHandler }),
});
export const contextTaskCompleteCommand = ccCommands.defineCommand(
  contextTaskCompleteSpec,
  {
    examples: [{ why: "Mark a task done", args: { "task-id": "t1" } }],
    handler: async () => ({ default: (await handlers()).taskCompleteHandler }),
  },
);
export const contextTaskReopenCommand = ccCommands.defineCommand(
  contextTaskReopenSpec,
  {
    examples: [{ why: "Reopen a task", args: { "task-id": "t1" } }],
    handler: async () => ({ default: (await handlers()).taskReopenHandler }),
  },
);
export const contextTaskAddCommand = ccCommands.defineCommand(
  contextTaskAddSpec,
  {
    examples: [
      {
        why: "Add a missing task",
        args: { "task-id": "t3" },
        flags: { title: "Cover the refusal" },
      },
    ],
    handler: async () => ({ default: (await handlers()).taskAddHandler }),
  },
);

export const runCommands = [
  runLaunchCommand,
  runWorkflowCommand,
  runAmendCommand,
  runDefinitionCommand,
  runShowCommand,
  runAnswerCommand,
  runPauseCommand,
  runResumeCommand,
  runCancelCommand,
  runRetryCommand,
  contextTaskCompleteCommand,
  contextTaskReopenCommand,
  contextTaskAddCommand,
] as const;
export const runGroups = [
  defineGroup({
    path: "run",
    summary: "Launch and steer supervised agent runs",
    description:
      "A run belongs to the conversation that launched it; that conversation answers its questions and receives its result.",
  }),
  defineGroup({
    path: "context",
    summary: "Work inside a supervised context",
    description: "Commands for the agent a run assigned to a context.",
  }),
  defineGroup({
    path: "context task",
    summary: "Report progress on your context's tasks",
    description:
      "Task commands apply to the context your conversation is working.",
  }),
] as const;
