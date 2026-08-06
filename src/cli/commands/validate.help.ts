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
      "List registered command names, declared costs, descriptions, scope support, and whether each command is enabled for this caller. Also reports current global capacity. The underlying executable is intentionally never shown.",
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
      "Submit one command through ValidationService. Admission is fail-fast by default; --wait joins the strict FIFO queue. Once admitted, the CLI polls through completion and renews its private lease. Values after `--` are server-validated narrowing paths, never tool options.",
    usage: [
      "cctl validate run <name> [--wait] [--json] [-- <validated paths>]",
    ],
    flags: [
      {
        name: "wait",
        kind: "boolean",
        description: "queue behind older work instead of refusing when busy",
      },
    ],
    examples: [
      {
        invocation: "cctl validate run test --wait -- src/lib/example.test.ts",
        explanation:
          "queue a focused test run; the server rejects option tokens and paths escaping the target worktree",
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
