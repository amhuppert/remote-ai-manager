import { defineGroup } from "cli-for-agents";
import { ccCommands } from "../../framework/family";

const text = { kind: "string", minLength: 1 } as const;
const common = {
  since: {
    description: "Ignore records before this ISO timestamp",
    value: text,
  },
  until: {
    description: "Ignore records after this ISO timestamp",
    value: text,
  },
  "project-name": { description: "Keep this logged project", value: text },
  "session-name": { description: "Keep this logged session", value: text },
  "conversation-id": {
    description: "Keep this logged conversation",
    value: text,
  },
  path: { description: "Keep this request path", value: text },
  action: { description: "Keep this server action", value: text },
  "include-self": {
    description: "Include the analyzer's own log records",
    value: { kind: "boolean" },
  },
  top: {
    description: "Rows per ranked section",
    value: { kind: "integer", min: 1, max: 100 },
    default: 10,
  },
  "slow-ms": {
    description: "Slow request threshold in milliseconds",
    value: { kind: "integer", min: 0 },
    default: 500,
  },
  "hotspot-ms": {
    description: "Operation hotspot threshold in milliseconds",
    value: { kind: "integer", min: 0 },
    default: 1000,
  },
} as const;
const input = {
  description:
    "Server log file; defaults to the machine's global and scoped logs",
  value: text,
} as const;
const read = { requires: "none", effects: "read", args: [] } as const;
export const logReportSpec = {
  ...read,
  path: "logs report",
  summary: "Rank slow requests and performance findings",
  description:
    "Analyze local server logs without a server connection. Identity flags are refused; use the record filters instead. Full permits an artifact destination; speedscope exports a flamegraph trace.",
  output: "binary",
  flags: {
    ...common,
    in: input,
    "client-log": {
      description: "Browser log for timing correlation",
      value: text,
    },
  },
  levels: {
    full: { output: "artifact-eligible" },
    speedscope: { output: "artifact-eligible" },
  },
} as const;
export const logTraceSpec = {
  ...read,
  path: "logs trace",
  summary: "Explain a trace's timeline and spans",
  description:
    "Read bounded trace sections and accounted/unexplained time. Full returns all rows; speedscope exports an exact flamegraph artifact. This operation is offline.",
  output: "binary",
  args: [
    {
      name: "trace-id",
      description: "Trace id from a log report",
      value: text,
    },
  ],
  flags: { ...common, in: input },
  levels: {
    full: { output: "artifact-eligible" },
    speedscope: { output: "artifact-eligible" },
  },
} as const;
export const logCompareSpec = {
  ...read,
  path: "logs compare",
  summary: "Compare performance before and after a change",
  description:
    "Analyze two local logs through the same filters, reporting timing and error deltas and changed findings. Full permits an artifact destination.",
  flags: {
    ...common,
    before: { description: "Baseline log path", value: text, required: true },
    after: {
      description: "Log path after the change",
      value: text,
      required: true,
    },
  },
  levels: { full: { output: "artifact-eligible" } },
} as const;
export const logReportCommand = ccCommands.defineCommand(logReportSpec, {
  examples: [{ why: "Find the traces responsible for a slowdown" }],
  handler: async () => ({
    default: (await import("./handlers")).reportHandler,
  }),
});
export const logTraceCommand = ccCommands.defineCommand(logTraceSpec, {
  examples: [
    {
      args: { "trace-id": "trace-one" },
      why: "Explain one trace identified by a report",
    },
  ],
  handler: async () => ({ default: (await import("./handlers")).traceHandler }),
});
export const logCompareCommand = ccCommands.defineCommand(logCompareSpec, {
  examples: [
    {
      flags: { before: "/logs/before.log", after: "/logs/after.log" },
      why: "Measure the effect of a performance change",
    },
  ],
  handler: async () => ({
    default: (await import("./handlers")).compareHandler,
  }),
});
export const logsCommands = [
  logReportCommand,
  logTraceCommand,
  logCompareCommand,
] as const;
export const logsGroups = [
  defineGroup({
    path: "logs",
    summary: "Analyze local structured logs",
    description:
      "Offline performance reports, trace reconstruction, and before/after comparisons. Identity flags do not select log records.",
  }),
] as const;
