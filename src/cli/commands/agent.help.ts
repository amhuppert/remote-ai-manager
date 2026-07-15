import type { CommandHelpEntry } from "../help-types";

/**
 * Help-registry entries for `cctl agent`: the group hub plus the
 * run/status/cancel leaves. Flags match `agent.ts`'s `checkFlags`
 * (run: file/wait/timeout; status and cancel: none).
 */
export const agentHelpEntries: CommandHelpEntry[] = [
  {
    path: ["agent"],
    summary: "run, poll, and cancel one-shot sub-agent jobs",
    description:
      "Run a backend agent (e.g. OpenAI Codex) as a one-shot sub-agent in this worktree. Job-shaped: the server runs it and the CLI observes it, so a run that outlives a killed client is recovered with `status`. The prompt payload names the backend.",
    usage: ["cctl agent <run|status|cancel>"],
    flags: [],
    examples: [],
    related: [],
  },
  {
    path: ["agent", "run"],
    summary: "start an agent run (optionally waiting for it)",
    description:
      'Start a run from a prompt file. File-only input: author .cc/temp/prompt.json (git-ignored scratch) as a JSON object { "backend": "codex", "prompt": "<task>" } with the Write tool (optional fields: model, reasoning_effort, timeoutMs, workingDirectory). The agent writes detail to files and returns a short summary plus a referenceDocuments list — read the referenced files, do not rely on the summary alone. Without --wait it returns a runId to poll.',
    usage: [
      "cctl agent run --file .cc/temp/prompt.json [--wait [--timeout <dur>]] [--json]",
    ],
    flags: [
      {
        name: "file",
        kind: "value",
        valuePlaceholder: "<prompt.json>",
        description:
          'JSON object { "backend": "<id>", "prompt": "<task>" } — the run input',
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
        invocation: "cctl agent run --file .cc/temp/prompt.json --wait",
        explanation:
          'the payload is {"backend":"codex","prompt":"<task>"}; --wait blocks and prints summary + referenceDocuments — read those files',
      },
      {
        invocation: "cctl agent run --file .cc/temp/prompt.json",
        explanation:
          "without --wait it returns a runId; the run continues server-side — recover it with `cctl agent status <runId>` (a killed --wait loses nothing)",
      },
    ],
    related: [
      {
        command: "agent status",
        oneLiner: "poll a run / recover the result of a killed --wait",
      },
      { command: "agent cancel", oneLiner: "abort a live run" },
    ],
  },
  {
    path: ["agent", "status"],
    summary: "read a run's state (and recover its result)",
    description:
      "Read a run's current state (running, or terminal completed/failed). A completed run reproduces the full result (summary + reference documents) — this is how you recover a run whose --wait was killed. Reading always exits 0; the run's own outcome is in the output. An unknown runId exits 2.",
    usage: ["cctl agent status <runId> [--json]"],
    flags: [],
    examples: [
      {
        invocation: "cctl agent status run-4f1d2797",
        explanation:
          "poll after a bare `run` or a killed --wait; a completed run reprints summary + referenceDocuments",
      },
    ],
    related: [
      { command: "agent run", oneLiner: "start a run" },
      { command: "agent cancel", oneLiner: "abort a run still running" },
    ],
  },
  {
    path: ["agent", "cancel"],
    summary: "abort a live agent run",
    description:
      "Abort a live run by id. Idempotent; an unknown runId exits 2. Terminal: no hint.",
    usage: ["cctl agent cancel <runId>"],
    flags: [],
    examples: [
      {
        invocation: "cctl agent cancel run-4f1d2797",
        explanation:
          "the <runId> comes from `agent run` output or `agent status`",
      },
    ],
    related: [
      { command: "agent status", oneLiner: "check a run before cancelling it" },
      { command: "agent run", oneLiner: "start a new run" },
    ],
  },
];
