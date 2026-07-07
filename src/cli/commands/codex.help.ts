import type { CommandHelpEntry } from "../help-types";

/**
 * Help-registry entries for `cctl codex` (docs/design/cc-cli/04 §2.2/§2.4): the
 * group hub plus the run/status/cancel leaves. Ported from the legacy `help.ts`
 * block and the cc-cli SKILL.md; flags match `codex.ts`'s `checkFlags`
 * (run: file/wait/timeout; status and cancel: none).
 */
export const codexHelpEntries: CommandHelpEntry[] = [
  {
    path: ["codex"],
    summary: "run, poll, and cancel one-shot Codex jobs",
    description:
      "Run OpenAI Codex as a one-shot sub-agent in this worktree. Job-shaped: the server runs it and the CLI observes it, so a run that outlives a killed client is recovered with `status`.",
    usage: ["cctl codex <run|status|cancel>"],
    flags: [],
    examples: [],
    related: [],
  },
  {
    path: ["codex", "run"],
    summary: "start a Codex run (optionally waiting for it)",
    description:
      'Start a run from a prompt file. File-only input: author .cc/temp/prompt.json (git-ignored scratch) as a JSON object { "prompt": "<task>" } with the Write tool (optional fields: model, reasoning_effort, timeoutMs, workingDirectory). Codex writes detail to files and returns a short summary plus a referenceDocuments list — read the referenced files, do not rely on the summary alone. Without --wait it returns a runId to poll.',
    usage: [
      "cctl codex run --file .cc/temp/prompt.json [--wait [--timeout <dur>]] [--json]",
    ],
    flags: [
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<prompt.json>",
        description: 'JSON object { "prompt": "<task>" } — the run input',
      },
      {
        name: "wait",
        kind: "boolean",
        description:
          "long-poll until the run finishes instead of returning a runId",
      },
      {
        name: "timeout",
        kind: "value",
        valuePlaceholder: "<dur>",
        description:
          "bound the CLI wait (25m, 90s, 500ms, or bare seconds) — NOT the run; only with --wait",
      },
    ],
    examples: [
      {
        invocation: "cctl codex run --file .cc/temp/prompt.json --wait",
        explanation:
          'the payload is {"prompt":"<task>"}; --wait blocks and prints summary + referenceDocuments — read those files',
      },
      {
        invocation: "cctl codex run --file .cc/temp/prompt.json",
        explanation:
          "without --wait it returns a runId; the run continues server-side — recover it with `cctl codex status <runId>` (a killed --wait loses nothing)",
      },
    ],
    related: [
      {
        command: "codex status",
        oneLiner: "poll a run / recover the result of a killed --wait",
      },
      { command: "codex cancel", oneLiner: "abort a live run" },
    ],
  },
  {
    path: ["codex", "status"],
    summary: "read a run's state (and recover its result)",
    description:
      "Read a run's current state (running, or terminal succeeded/failed/timed_out). A succeeded run reproduces the full result (summary + reference documents) — this is how you recover a run whose --wait was killed. Reading always exits 0; the run's own outcome is in the output. An unknown runId exits 2.",
    usage: ["cctl codex status <runId> [--json]"],
    flags: [],
    examples: [
      {
        invocation: "cctl codex status run-4f1d2797",
        explanation:
          "poll after a bare `run` or a killed --wait; a succeeded run reprints summary + referenceDocuments",
      },
    ],
    related: [
      { command: "codex run", oneLiner: "start a run" },
      { command: "codex cancel", oneLiner: "abort a run still running" },
    ],
  },
  {
    path: ["codex", "cancel"],
    summary: "abort a live Codex run",
    description:
      "Abort a live run by id. Idempotent; an unknown runId exits 2. Terminal: no hint.",
    usage: ["cctl codex cancel <runId>"],
    flags: [],
    examples: [
      {
        invocation: "cctl codex cancel run-4f1d2797",
        explanation:
          "the <runId> comes from `codex run` output or `codex status`",
      },
    ],
    related: [
      { command: "codex status", oneLiner: "check a run before cancelling it" },
      { command: "codex run", oneLiner: "start a new run" },
    ],
  },
];
