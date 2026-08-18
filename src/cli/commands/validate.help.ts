import type { CommandHelpEntry } from "../help-types";

const VALIDATION_CONTEXT =
  "Every registered validation execution enters the server-owned ValidationService and its global cost budget.\nNever invoke a registered script or tool alias directly, and never bypass a queue or workflow policy.";

const PROJECT_SETUP_SKILL = {
  name: "project-setup",
  loadWhen: "when registering or changing project validation commands",
  path: "plugins/command-center/command-center/skills/project-setup/SKILL.md",
} as const;

export const validateHelpEntries: CommandHelpEntry[] = [
  {
    path: ["validate"],
    summary: "list and run registered validation under the global cost budget",
    description:
      "Inspect registered validation commands, run one through the server-owned scheduler, poll active runs, or cancel a run you submitted.",
    usage: ["cctl validate <list|run|status|cancel>"],
    flags: [],
    examples: [],
    domainContext: VALIDATION_CONTEXT,
    related: [],
    skills: [PROJECT_SETUP_SKILL],
  },
  {
    path: ["validate", "list"],
    summary: "list commands, policy enablement, and current capacity",
    description:
      "List registered command names, declared costs, descriptions, scope support, and whether each command is enabled for this caller. A command may declare one cost for every scope (`cost 4`) or a scope-aware table rendered with omitted weights resolved (`cost 5 (changed 5, paths 2+1/path)` reserves 5 for a full run, 5 for a changed run, and 2 plus 1 per forwarded path — never above the changed weight). Also reports current global capacity. The underlying executable is intentionally never shown.",
    usage: ["cctl validate list [--json]"],
    flags: [],
    examples: [
      {
        invocation: "cctl validate list",
        explanation:
          "inspect command names and honest costs before choosing a validation run; disabled commands are policy no-ops",
      },
    ],
    domainContext: VALIDATION_CONTEXT,
    related: [
      { command: "validate run", oneLiner: "run one listed command" },
      {
        command: "validate status",
        oneLiner: "inspect active validation runs",
      },
    ],
    skills: [PROJECT_SETUP_SKILL],
  },
  {
    path: ["validate", "run"],
    summary: "run one registered validation command",
    description:
      "Submit one logical command through ValidationService. Scope defaults to changed; a command without native changed support falls back to full. Every submission blocks to a verdict — --wait decides only how a busy scheduler answers, joining the strict FIFO queue instead of refusing immediately, unlike `agent run --wait` and `workflow run --wait` which decide whether to block at all. Values after `--` are changed-run narrowing paths, never tool options. A pass prints one verdict line naming the command, the resolved scope, the matched-file count when the server resolved one, and the run id, then the tail of the runner output; the same facts are fields on the --json envelope. A path after `--` that matches nothing still passes and says `0 files matched`, so read the verdict line rather than trusting a silent green. --timeout bounds only this client wait; on expiry the run continues server-side and the failure names the status command that recovers its verdict.",
    usage: [
      "cctl validate run <name> [--scope changed|full] [--wait] [--timeout <dur>] [--require-match] [--json] [-- <validated paths>]",
    ],
    flags: [
      {
        name: "scope",
        kind: "value",
        valuePlaceholder: "<changed|full>",
        description:
          "request affected-work or full validation (default: changed)",
      },
      {
        name: "wait",
        kind: "boolean",
        description: "queue behind older work instead of refusing when busy",
      },
      {
        name: "timeout",
        kind: "value",
        valuePlaceholder: "<dur>",
        description:
          "client wait budget including queue time (e.g. 45m, 90s; default 2h)",
      },
      {
        name: "require-match",
        kind: "boolean",
        description:
          "exit 1 when the paths after `--` matched no files; a run that forwards no paths carries no count and is unaffected",
      },
    ],
    examples: [
      {
        invocation: "cctl validate run test --wait -- src/lib/example.test.ts",
        explanation:
          "queue a focused test run; the server rejects option tokens and paths escaping the target worktree",
      },
      {
        invocation: "cctl validate run test --scope full --wait",
        explanation:
          "run the full variant of the same logical test command; full scope reserves the command's full weight under the same shared timeout",
      },
    ],
    domainContext: VALIDATION_CONTEXT,
    related: [
      {
        command: "validate list",
        oneLiner: "inspect registered names, costs, and enablement",
      },
      {
        command: "validate status",
        oneLiner: "inspect the submitted run",
      },
      {
        command: "validate cancel",
        oneLiner: "cancel an owned run explicitly",
      },
    ],
  },
  {
    path: ["validate", "status"],
    summary: "inspect active validation or one run",
    description:
      "Without a run id, list active queued/running validation jobs and global capacity. With a run id, show its status, queue position, and terminal result when available. Read-only status does not renew another submitter's lease.",
    usage: ["cctl validate status [run-id] [--json]"],
    flags: [],
    examples: [
      {
        invocation: "cctl validate status vrun-4f1d2797",
        explanation:
          "inspect one run by the id returned from submission; omit the id for the active-run list",
      },
    ],
    domainContext: VALIDATION_CONTEXT,
    related: [
      { command: "validate run", oneLiner: "submit a validation run" },
      {
        command: "validate cancel",
        oneLiner: "cancel an owned active run",
      },
      {
        command: "validate list",
        oneLiner: "inspect registered commands and capacity",
      },
    ],
  },
  {
    path: ["validate", "cancel"],
    summary: "cancel an owned validation run",
    description:
      "Cancel an active run using the submitter's private lease retained by this cctl installation while `validate run` is active. `validate run` also cancels automatically on SIGINT/SIGTERM; lease expiry remains the fallback when a client dies before cancellation completes.",
    usage: ["cctl validate cancel <run-id> [--json]"],
    flags: [],
    examples: [
      {
        invocation: "cctl validate cancel vrun-4f1d2797",
        explanation:
          "cancel an active run submitted from the same Command Center installation",
      },
    ],
    domainContext: VALIDATION_CONTEXT,
    related: [
      {
        command: "validate status",
        oneLiner: "check the run before cancellation",
      },
      { command: "validate run", oneLiner: "submit a validation run" },
    ],
  },
];
