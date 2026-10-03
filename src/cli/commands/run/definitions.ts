import { bytes, defineGroup } from "cli-for-agents";
import { ccCommands } from "../../framework/family";

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
  description: "Nothing new starts; work already admitted finishes. Resume with run resume.",
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
      description: "Halt occurrence from run show; a stale occurrence is refused",
      value: { kind: "string", minLength: 1 },
    },
    disposition: {
      description: "How to clear the halt",
      value: {
        kind: "enum",
        values: ["continue", "retry", "retry_capture", "retry_advice", "replace_seat", "rereview", "grant", "confirm_effect"],
      },
    },
    allowance: {
      description: "Allowance a grant adds to",
      value: { kind: "enum", values: ["unfinishedTaskRetries", "validationRetries"] },
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
      description: "What you checked to confirm an uncertain effect (confirm_effect)",
      value: { kind: "string", minLength: 1, maxLength: 2000 },
    },
  },
} as const;
export const runCancelSpec = {
  path: "run cancel",
  summary: "Cancel a run you launched",
  description: "Stops every context in the run; admitted turns are interrupted and their partial work kept.",
  requires: "cc",
  effects: "write",
  args: [runId],
  flags: {},
} as const;
export const contextTaskCompleteSpec = {
  path: "context task complete",
  summary: "Mark one of your context's tasks done",
  description: "For the agent working a supervised context: record that a task in your task list is done.",
  requires: "cc",
  effects: "write",
  args: [taskId],
  flags: {},
} as const;
export const contextTaskReopenSpec = {
  path: "context task reopen",
  summary: "Reopen one of your context's tasks",
  description: "For the agent working a supervised context: record that a task you completed is not done.",
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
  examples: [{ file: ".cc/temp/run.json", why: "Launch an agent from a brief" }],
  handler: async () => ({ default: (await handlers()).launchHandler }),
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
      flags: { context: "run-1.agent", occurrence: "occ-1", disposition: "continue" },
    },
  ],
  handler: async () => ({ default: (await handlers()).resumeHandler }),
});
export const runCancelCommand = ccCommands.defineCommand(runCancelSpec, {
  examples: [{ why: "Cancel a run", args: { "run-id": "run-1" } }],
  handler: async () => ({ default: (await handlers()).cancelHandler }),
});
export const contextTaskCompleteCommand = ccCommands.defineCommand(contextTaskCompleteSpec, {
  examples: [{ why: "Mark a task done", args: { "task-id": "t1" } }],
  handler: async () => ({ default: (await handlers()).taskCompleteHandler }),
});
export const contextTaskReopenCommand = ccCommands.defineCommand(contextTaskReopenSpec, {
  examples: [{ why: "Reopen a task", args: { "task-id": "t1" } }],
  handler: async () => ({ default: (await handlers()).taskReopenHandler }),
});
export const contextTaskAddCommand = ccCommands.defineCommand(contextTaskAddSpec, {
  examples: [{ why: "Add a missing task", args: { "task-id": "t3" }, flags: { title: "Cover the refusal" } }],
  handler: async () => ({ default: (await handlers()).taskAddHandler }),
});

export const runCommands = [
  runLaunchCommand,
  runShowCommand,
  runAnswerCommand,
  runPauseCommand,
  runResumeCommand,
  runCancelCommand,
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
    description: "Task commands apply to the context your conversation is working.",
  }),
] as const;
