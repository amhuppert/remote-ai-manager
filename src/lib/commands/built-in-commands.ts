/**
 * The slash commands Command Center implements itself, and which commands the
 * composer may offer for a given conversation scope.
 *
 * Availability is a property of the NAME, not of the catalog an item arrived
 * in. CC intercepts these names before the agent sees them (see
 * `parseConversationCommand`), so a project root that happens to contain a
 * `commit.md` produces a discovered `/commit` that is no more executable at
 * project scope than the built-in one. Scope eligibility is therefore applied
 * to the combined catalog — built-ins and discovered commands alike — rather
 * than to the built-in list on its own (R7.3).
 */

import type { ConversationScopeRef } from "@/lib/conversations/conversation-target";
import type { CommandItem } from "./schemas";
import type { BuiltInCommandName } from "./schemas";
import type { ExecutionRequirements } from "@/lib/agent-backends/execution-admission";

export const messageGenerationRequirements = {
  facet: "tasks",
  executionClass: "nongoverned-task",
  executionProfile: "standard",
  operation: "message-generation",
} as const satisfies ExecutionRequirements;
export const automaticRepairRequirements = {
  facet: "tasks",
  executionClass: "governed-execution",
  executionProfile: "standard",
  requiresPrivilegedInstructions: true,
  operation: "automatic-repair",
} as const satisfies ExecutionRequirements;

interface CommandExecution {
  required: readonly ExecutionRequirements[];
  stages: readonly {
    stage: "message-generation" | "validation-repair" | "conflict-assistance";
    requirements: readonly ExecutionRequirements[];
  }[];
}

export const BUILT_IN_COMMAND_EXECUTION = {
  "/spec": { required: [], stages: [] },
  "/align": { required: [], stages: [] },
  "/ticket": {
    required: [
      { ...messageGenerationRequirements, operation: "ticket" },
      {
        ...messageGenerationRequirements,
        operation: "ticket-repair",
        executionProfile: "isolated-one-shot",
      },
    ],
    stages: [],
  },
  "/collab": {
    required: [
      automaticRepairRequirements,
      {
        facet: "conversation",
        executionClass: "governed-execution",
        operation: "collaboration",
      },
    ],
    stages: [],
  },
  "/commit": {
    required: [],
    stages: [
      {
        stage: "message-generation",
        requirements: [
          messageGenerationRequirements,
          {
            ...messageGenerationRequirements,
            executionProfile: "isolated-one-shot",
          },
        ],
      },
      {
        stage: "validation-repair",
        requirements: [automaticRepairRequirements],
      },
    ],
  },
  "/merge": {
    required: [],
    stages: [
      {
        stage: "message-generation",
        requirements: [
          messageGenerationRequirements,
          {
            ...messageGenerationRequirements,
            executionProfile: "isolated-one-shot",
          },
        ],
      },
      {
        stage: "validation-repair",
        requirements: [automaticRepairRequirements],
      },
      {
        stage: "conflict-assistance",
        requirements: [automaticRepairRequirements],
      },
    ],
  },
  "/rebase": {
    required: [],
    stages: [
      {
        stage: "conflict-assistance",
        requirements: [automaticRepairRequirements],
      },
    ],
  },
} as const satisfies Record<BuiltInCommandName, CommandExecution>;

interface BuiltInCommand {
  readonly item: CommandItem;
  /**
   * Whether the command resolves at project scope. False means the command
   * needs a session branch or worktree, or is refused by the project boundary
   * itself; offering it there would surface a scope decision as a failure after
   * the user has already sent the turn.
   */
  readonly availableAtProjectScope: boolean;
}

const BUILT_IN_CLAUDE_COMMANDS: readonly BuiltInCommand[] = [
  {
    item: {
      name: "/spec",
      description: "Author a durable native Command Center spec.",
      argumentHint: "<what-to-specify>",
      type: "command",
      source: "built-in",
    },
    availableAtProjectScope: true,
  },
  {
    item: {
      name: "/collab",
      description:
        "Run two agents in parallel and converge to a merged result.",
      type: "command",
      source: "built-in",
    },
    // Refused by the project boundary itself: manual collaboration negotiates
    // and lands changes on a session branch and worktree.
    availableAtProjectScope: false,
  },
  {
    item: {
      name: "/commit",
      description: "Commit session changes with an agent-written message.",
      argumentHint: "[message guidance]",
      type: "command",
      source: "built-in",
    },
    availableAtProjectScope: false,
  },
  {
    item: {
      name: "/merge",
      description:
        "Smart-merge the session into its target with an agent-written squash message.",
      argumentHint: "[message guidance]",
      type: "command",
      source: "built-in",
    },
    availableAtProjectScope: false,
  },
  {
    item: {
      name: "/rebase",
      description:
        "Rebase the session branch onto another branch (defaults to its target), auto-resolving conflicts.",
      argumentHint: "[[remote] branch]",
      type: "command",
      source: "built-in",
    },
    availableAtProjectScope: false,
  },
  {
    item: {
      name: "/align",
      description:
        "Draft or update the session's shared Alignment charter from the conversation.",
      argumentHint: "[guidance]",
      type: "command",
      source: "built-in",
    },
    // Alignment governs a bounded session objective and rejects project
    // conversations.
    availableAtProjectScope: false,
  },
  {
    item: {
      name: "/ticket",
      description:
        "Create a ticket from this conversation's accumulated context.",
      argumentHint: "[hint text]",
      type: "command",
      source: "built-in",
    },
    // The ticket lands in the conversation's project, and the command service
    // treats a session-less conversation as a project conversation rather than
    // requiring a session worktree.
    availableAtProjectScope: true,
  },
];

/** CC's own commands, before any scope filtering. */
export const BUILT_IN_COMMANDS: readonly CommandItem[] =
  BUILT_IN_CLAUDE_COMMANDS.map((command) => command.item);

const SESSION_ONLY_COMMAND_NAMES: ReadonlySet<string> = new Set(
  BUILT_IN_CLAUDE_COMMANDS.filter(
    (command) => !command.availableAtProjectScope,
  ).map((command) => command.item.name),
);

export interface CommandScopeFilterArgs {
  scope: ConversationScopeRef;
  /**
   * Graph-workflow lane conversations (the composer mounts for them while an
   * approval gate or parked question is open) must not advertise `/ticket` —
   * the server rejects the command for lanes.
   */
  isWorkflowManagedConversation: boolean;
}

/**
 * Drop the commands `scope` cannot execute, whatever catalog they came from.
 */
export function filterCommandsForScope(
  items: readonly CommandItem[],
  { scope, isWorkflowManagedConversation }: CommandScopeFilterArgs,
): CommandItem[] {
  return items.filter((item) => {
    if (
      scope.scope === "project" &&
      SESSION_ONLY_COMMAND_NAMES.has(item.name)
    ) {
      return false;
    }
    return !(isWorkflowManagedConversation && item.name === "/ticket");
  });
}
