import type { CommandHelpEntry, FlagSpec } from "../help-types";

const PERFORMANCE_SKILL = {
  name: "cc-performance-log-analysis",
  loadWhen: "before diagnosing a slowdown or a before/after regression",
  path: ".claude/skills/cc-performance-log-analysis/SKILL.md",
} as const;

const DEBUG_SKILL = {
  name: "debug-logs",
  loadWhen: "when tracing what happened during a failed run",
  path: ".claude/skills/debug-logs/SKILL.md",
} as const;

/**
 * The record filters every verb accepts. They select which log records enter the
 * analysis; the analysis itself is unchanged by them.
 */
const FILTER_FLAGS: FlagSpec[] = [
  {
    name: "since",
    kind: "value",
    valuePlaceholder: "<iso>",
    description: "ignore records before this ISO timestamp",
  },
  {
    name: "until",
    kind: "value",
    valuePlaceholder: "<iso>",
    description: "ignore records after this ISO timestamp",
  },
  {
    name: "project-name",
    kind: "value",
    valuePlaceholder: "<name>",
    description: "keep only records logged for this project",
  },
  {
    name: "session-name",
    kind: "value",
    valuePlaceholder: "<name>",
    description: "keep only records logged for this session",
  },
  {
    name: "conversation-id",
    kind: "value",
    valuePlaceholder: "<id>",
    description: "keep only records logged for this conversation",
  },
  {
    name: "path",
    kind: "value",
    valuePlaceholder: "<api-path>",
    description: "keep only records for this request path",
  },
  {
    name: "action",
    kind: "value",
    valuePlaceholder: "<action>",
    description: "keep only records for this server action",
  },
  {
    name: "include-self",
    kind: "boolean",
    description:
      "keep the analyzer's own log records (excluded by default so a run does not measure itself)",
  },
];

/** The ranking knobs shared by every verb. */
const THRESHOLD_FLAGS: FlagSpec[] = [
  {
    name: "top",
    kind: "value",
    valuePlaceholder: "<n>",
    description: "rows per ranked section (default 10)",
  },
  {
    name: "slow-ms",
    kind: "value",
    valuePlaceholder: "<n>",
    description: "duration at which a request counts as slow (default 500)",
  },
  {
    name: "hotspot-ms",
    kind: "value",
    valuePlaceholder: "<n>",
    description:
      "duration at which an operation counts as a hotspot (default 1000)",
  },
];

const OUT_FLAG: FlagSpec = {
  name: "out",
  kind: "value",
  valuePlaceholder: "<path>",
  description:
    "write the analysis to this file and print its manifest instead of the content",
};

const SPEEDSCOPE_FLAG: FlagSpec = {
  name: "speedscope-out",
  kind: "value",
  valuePlaceholder: "<path>",
  description:
    "also write a speedscope.app trace file of the timed spans (flamegraph view)",
};

const IN_FLAG: FlagSpec = {
  name: "in",
  kind: "value",
  valuePlaceholder: "<path>",
  description:
    "log file to analyze (default: this machine's CC server log plus its scoped session/conversation logs)",
};

const LOGS_CONTEXT =
  "The CC server writes structured NDJSON logs under its config dir: a global log plus per-session and per-conversation logs.\nAnalysis reads those files on this machine — it never contacts the CC server, so it also works while the server is down.\nNo server identity is involved: --project/--session/--conversation are refused here, pointing at the record filter meant instead.";

/**
 * Help-registry entries for `cctl logs` (docs/design/cc-cli/09 §8). The verbs
 * mirror the bounded analysis engine in `src/lib/logging/log-analysis`, which
 * owns every analysis decision; these entries describe only the CLI surface.
 */
export const logsHelpEntries: CommandHelpEntry[] = [
  {
    path: ["logs"],
    summary: "analyze this machine's CC server logs offline",
    description:
      "Turn the structured server logs already on disk into ranked findings: report one log, deep-dive one trace, or compare a before/after pair.",
    usage: ["cctl logs <report|trace|compare>"],
    flags: [],
    examples: [],
    domainContext: LOGS_CONTEXT,
    related: [
      {
        command: "doctor",
        oneLiner:
          "check connectivity/auth first when a command failed to reach the server",
      },
    ],
    skills: [PERFORMANCE_SKILL, DEBUG_SKILL],
  },
  {
    path: ["logs", "report"],
    summary: "rank slow requests, hotspots, duplicate work, and errors",
    description:
      "Analyze one log and print severity-ranked findings — slow requests, operation hotspots, duplicate work, state-store and SSE cost, external commands, and budget violations — with the trace ids to drill into. Text prints the analysis as Markdown; --json carries the same analysis as a structured `report` field. Past the stdout budget the analysis goes to a file and stdout carries its manifest.",
    usage: [
      "cctl logs report [--in <path>] [--since <iso>] [--until <iso>] [--top <n>] [--out <path>] [--json]",
    ],
    flags: [
      IN_FLAG,
      {
        name: "client-log",
        kind: "value",
        valuePlaceholder: "<path>",
        description:
          "browser log to correlate client-side timing against the server records",
      },
      ...FILTER_FLAGS,
      ...THRESHOLD_FLAGS,
      SPEEDSCOPE_FLAG,
      OUT_FLAG,
    ],
    examples: [
      {
        invocation: "cctl logs report",
        explanation:
          "the first move on 'why is CC slow' — ranked findings over the newest log on this machine",
      },
      {
        invocation:
          "cctl logs report --since 2026-08-18T09:00:00Z --path /api/projects",
        explanation:
          "narrow to one endpoint inside the window a regression was observed in",
      },
    ],
    domainContext: LOGS_CONTEXT,
    related: [
      {
        command: "logs trace",
        oneLiner: "deep-dive one trace id this report ranked",
      },
      {
        command: "logs compare",
        oneLiner: "measure a change against a before log",
      },
    ],
    skills: [PERFORMANCE_SKILL, DEBUG_SKILL],
  },
  {
    path: ["logs", "trace"],
    summary: "deep-dive one trace: timeline, spans, and unexplained time",
    description:
      "Reconstruct one request from its trace id: the ordered timeline, inclusive and exclusive span totals, duplicate work, warnings and errors, and the time no span accounts for. A trace id absent from the log is an operation failure naming the id.",
    usage: [
      "cctl logs trace <traceId> [--in <path>] [--top <n>] [--out <path>] [--json]",
    ],
    flags: [
      IN_FLAG,
      {
        name: "since",
        kind: "value",
        valuePlaceholder: "<iso>",
        description: "ignore records before this ISO timestamp",
      },
      {
        name: "until",
        kind: "value",
        valuePlaceholder: "<iso>",
        description: "ignore records after this ISO timestamp",
      },
      {
        name: "include-self",
        kind: "boolean",
        description: "keep the analyzer's own log records",
      },
      ...THRESHOLD_FLAGS,
      SPEEDSCOPE_FLAG,
      OUT_FLAG,
    ],
    examples: [
      {
        invocation: "cctl logs trace 0197a3c2-4f1d-7e2b-9c8a-1d2e3f4a5b6c",
        explanation:
          "explain one slow request end to end after `cctl logs report` named its trace id",
      },
    ],
    domainContext: LOGS_CONTEXT,
    related: [
      {
        command: "logs report",
        oneLiner: "find the trace ids worth deep-diving",
      },
      {
        command: "logs compare",
        oneLiner: "measure a change against a before log",
      },
    ],
    skills: [PERFORMANCE_SKILL],
  },
  {
    path: ["logs", "compare"],
    summary: "compare two logs for regressions and improvements",
    description:
      "Compare a before and an after log over the same filters and report what moved — request and operation timing, error rates, and the findings that appeared or cleared. Both paths are required.",
    usage: [
      "cctl logs compare --before <path> --after <path> [--path <api-path>] [--out <path>] [--json]",
    ],
    flags: [
      {
        name: "before",
        kind: "value",
        valuePlaceholder: "<path>",
        description: "baseline log file (required)",
      },
      {
        name: "after",
        kind: "value",
        valuePlaceholder: "<path>",
        description: "log file recorded after the change (required)",
      },
      ...FILTER_FLAGS,
      ...THRESHOLD_FLAGS,
      OUT_FLAG,
    ],
    examples: [
      {
        invocation:
          "cctl logs compare --before .cc/temp/before.log --after .cc/temp/after.log",
        explanation:
          "prove a performance change moved the numbers instead of asserting it",
      },
    ],
    domainContext: LOGS_CONTEXT,
    related: [
      {
        command: "logs report",
        oneLiner: "analyze either side on its own",
      },
      {
        command: "logs trace",
        oneLiner: "explain one trace the comparison flagged",
      },
    ],
    skills: [PERFORMANCE_SKILL],
  },
];
