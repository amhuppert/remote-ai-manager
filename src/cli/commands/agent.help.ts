import type { CommandHelpEntry } from "../help-types";

/**
 * Help-registry entries for `cctl agent`: the group hub, the run/status/cancel
 * job leaves, and the list/get profile-library leaves. Flags match `agent.ts`'s
 * `checkFlags` (run: file/wait/timeout; every other verb: none).
 */
export const agentHelpEntries: CommandHelpEntry[] = [
  {
    path: ["agent"],
    summary: "run one-shot sub-agent jobs; read the agent profile library",
    description:
      "Two capabilities behind one noun. `run`/`status`/`cancel` execute a backend agent (e.g. OpenAI Codex) as a one-shot sub-agent in this worktree — job-shaped, so a run that outlives a killed client is recovered with `status`. `list`/`get` read the agent profile library: the prompt identities (name, description, instructions) a conversation or a workflow assignment can be staffed with.",
    usage: ["cctl agent <run|status|cancel|list|get>"],
    flags: [],
    examples: [],
    related: [],
  },
  {
    path: ["agent", "run"],
    summary: "start an agent run (optionally waiting for it)",
    description:
      'Start a run from a prompt file. File-only input: author .cc/temp/prompt.json (git-ignored scratch) as a JSON object { "backend": "codex", "prompt": "<task>" } with the Write tool (optional fields: modelSelection with { modelId, parameters }, timeoutMs, workingDirectory). The modelSelection is one complete atomic variant; parameter IDs and values come from that backend\'s effective catalog. The agent writes detail to files and returns a short summary plus a referenceDocuments list — read the referenced files, do not rely on the summary alone. Without --wait it returns a runId to poll.',
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
          'the payload is {"backend":"codex","prompt":"<task>","modelSelection":{"modelId":"gpt-5.4","parameters":{"reasoning":"high","fast":"false"}}}; omit modelSelection to use the configured atomic default; --wait blocks and prints summary + referenceDocuments — read those files',
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
  {
    path: ["agent", "list"],
    summary: "list the agent profile library across every tier",
    description:
      "List every agent profile reachable from this project: the curated `builtin` set, `global` profiles shared by every project on this install, and this project's own `project` profiles. This is the machine-discoverable selection surface — staff an assignment by reading each profile's description. Each record carries its qualified `tier:id`, revision, name, description, advisory `recommendedFor`, and tags. Instruction text is never in a listing; read it with `agent get`. A stored record that fails to parse is reported under `diagnostics` rather than failing the listing.",
    usage: ["cctl agent list [--json]"],
    flags: [],
    examples: [
      {
        invocation: "cctl agent list --json",
        explanation:
          "pick a profile by description; `recommendedFor` is advisory — filter and warn on it, never refuse on it",
      },
    ],
    related: [
      {
        command: "agent get",
        oneLiner: "read one profile's full instructions by tier:id",
      },
    ],
    domainContext:
      "Tiers are sibling scopes, not a shadowing chain: `global:reviewer` and `project:reviewer` are two different profiles and both list. A profile is prompt identity only — it carries no backend, model, effort, or tool policy.",
  },
  {
    path: ["agent", "get"],
    summary: "read one agent profile, including its instructions",
    description:
      "Read one profile by its QUALIFIED reference `tier:id` (`builtin`, `global`, or `project`). This is the one surface that carries instruction text. A bare id is refused before any request (exit 2): sibling tiers can hold the same id, so an unqualified reference would have to guess. An unknown tier, a malformed id, and a reference that resolves to nothing each exit 2 with a typed refusal naming the offending reference.",
    usage: ["cctl agent get <tier:id> [--json]"],
    flags: [],
    examples: [
      {
        invocation: "cctl agent get builtin:security-reviewer",
        explanation:
          "the qualified spelling is mandatory — `cctl agent get security-reviewer` is refused as unqualified",
      },
      {
        invocation: "cctl agent get project:contract-reviewer --json",
        explanation:
          "the JSON envelope's `profile` carries the full record (instructions included) at its current revision",
      },
    ],
    related: [
      {
        command: "agent list",
        oneLiner: "discover the qualified references to read",
      },
    ],
  },
];
