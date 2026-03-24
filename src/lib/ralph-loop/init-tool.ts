import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  getSession as defaultGetSession,
  mutateSession as defaultMutateSession,
} from "@/lib/state";
import {
  broadcast as defaultBroadcast,
  type BroadcastFn,
} from "@/lib/sse-broadcaster";
import { getErrorMessage } from "@/lib/errors";
import { createLogger } from "@/lib/logging";
import { readConfig as defaultReadConfig } from "@/lib/config";
import { claudeModelSchema, effortLevelSchema } from "@/lib/schemas";
import { createInitialCircuitBreakerState as defaultCreateInitialCircuitBreakerState } from "./circuit-breaker";
import { dispatchPlanGeneration as defaultDispatchPlanGeneration } from "./plan-generator";
import { createTask } from "./fix-plan-manager";

const logger = createLogger("ralph-loop");

// ============================================================
// Dependency Injection
// ============================================================

export interface InitToolDeps {
  getSession: typeof defaultGetSession;
  mutateSession: typeof defaultMutateSession;
  createInitialCircuitBreakerState: typeof defaultCreateInitialCircuitBreakerState;
  dispatchPlanGeneration: typeof defaultDispatchPlanGeneration;
  readConfig: typeof defaultReadConfig;
}

const defaultInitToolDeps: InitToolDeps = {
  getSession: defaultGetSession,
  mutateSession: defaultMutateSession,
  createInitialCircuitBreakerState: defaultCreateInitialCircuitBreakerState,
  dispatchPlanGeneration: defaultDispatchPlanGeneration,
  readConfig: defaultReadConfig,
};

export interface InitToolContext {
  projectPath: string;
  sessionName: string;
  projectName: string;
  /** Optional broadcast function for dependency injection (default: SSE broadcaster). */
  broadcast?: BroadcastFn;
  /** Optional dependency overrides for testing. */
  deps?: Partial<InitToolDeps>;
}

/**
 * Creates an in-process MCP server with the `initialize_ralph_loop` tool.
 * Registered conditionally in the prompt pipeline when no workflow exists.
 */
export function createInitToolServer(
  context: InitToolContext,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "ralph-loop-init",
    version: "1.0.0",
    tools: [
      tool(
        "initialize_ralph_loop",
        `Initialize a Ralph Loop autonomous workflow for this session. Call this when the user wants to start an iterative, autonomous coding workflow.

Use the /command-center:plan-ralph-loop skill to plan the workflow before calling this tool. If the skill is not available, follow these guidelines:

Analyze the user's request and break it into discrete, actionable tasks:
- Each task should be specific and achievable in a single iteration (roughly 10-30 minutes of work)
- Assign tasks to execution groups based on dependencies:
  - Group 1: Foundation tasks with no dependencies (core setup, schemas, initial implementations)
  - Group 2: Tasks that depend on group 1 completion
  - Group 3+: Tasks that depend on previous groups
- Tasks within the same group must be independent of each other
- Do not include meta-tasks like "review" or "test everything" — each task should include its own testing
- Executing agents only see the objective, task list, and codebase — not this conversation. Each task description must be self-contained: include the specific "what" and "why", reference files or patterns to follow when the agent can't easily discover them, and specify verification commands.
- When one task creates stubs/placeholders that a later task fills in, the later task MUST explicitly say to update the stub files. Never assume a later task will "just know" to wire things together.
- ALWAYS include a final task in the highest group that validates the complete implementation end-to-end. This task should verify that all components are wired together, the app builds/compiles successfully, and the deliverable works as a whole — not just that individual pieces pass their unit tests.`,
        {
          objective: z
            .string()
            .min(1)
            .describe("A concise summary of the overall development goal"),
          tasks: z
            .array(
              z.object({
                description: z
                  .string()
                  .min(1)
                  .describe(
                    "Self-contained task description for an agent with no access to this conversation. Include what to change, why, which files are involved, and how to verify. Achievable in a single iteration (roughly 10-30 minutes of work).",
                  ),
                group: z
                  .number()
                  .int()
                  .min(1)
                  .describe(
                    "Execution group (1-based). Group 1 = foundation tasks with no dependencies. Group 2 = tasks depending on group 1. Higher groups depend on all lower groups. Tasks within the same group must be independent of each other.",
                  ),
              }),
            )
            .min(1)
            .describe(
              "Structured task plan. Break the objective into discrete, actionable tasks grouped by dependency order.",
            ),
          references: z
            .array(
              z.object({
                filePath: z
                  .string()
                  .describe(
                    "Absolute path to a reference document in memory-bank/ralph-reference/ within the session worktree",
                  ),
                description: z
                  .string()
                  .describe(
                    "What the document contains and when the executing agent should read it",
                  ),
              }),
            )
            .optional()
            .describe(
              "Optional reference documents providing additional context. Create files in memory-bank/ralph-reference/ before calling this tool. Executing agents see file paths and descriptions in their iteration prompt and can read them on demand.",
            ),
          model: claudeModelSchema
            .optional()
            .describe(
              "Claude model for iterations. Defaults to the CC global config defaultModel.",
            ),
          effort: effortLevelSchema
            .optional()
            .describe(
              "Reasoning effort for iterations. Defaults to the CC global config defaultEffort, then 'high'.",
            ),
        },
        async (args) => {
          const { objective, tasks, references } = args;
          const {
            projectPath,
            sessionName,
            projectName,
            broadcast = defaultBroadcast,
            deps: depsOverride,
          } = context;

          const {
            getSession,
            mutateSession,
            createInitialCircuitBreakerState,
            readConfig,
          } = { ...defaultInitToolDeps, ...depsOverride };

          try {
            // Read fresh session state to guard against race conditions
            const session = await getSession(projectPath, sessionName);
            if (!session) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "Session not found. Cannot create workflow.",
                  },
                ],
                isError: true,
              };
            }

            if (session.workflow) {
              logger.info("init_tool.already_exists", { sessionName });
              return {
                content: [
                  {
                    type: "text" as const,
                    text: "A Ralph Loop workflow already exists for this session. Only one workflow per session is supported.",
                  },
                ],
                isError: true,
              };
            }

            // Resolve model and effort from args, falling back to global config
            const globalConfig = await readConfig();
            const resolvedModel = args.model ?? globalConfig.defaultModel;
            const resolvedEffort =
              args.effort ?? globalConfig.defaultEffort ?? "high";

            // Convert submitted tasks to FixPlanTask entries
            const fixPlan = tasks.map((t) =>
              createTask({ description: t.description, group: t.group }),
            );

            // Create the workflow via mutateSession
            const now = new Date().toISOString();
            await mutateSession(
              projectPath,
              sessionName,
              "initTool.createWorkflow",
              (sess) => {
                sess.workflow = {
                  status: "planning",
                  objective,
                  fixPlan,
                  references: references ?? [],
                  config: {
                    maxIterations: 20,
                    iterationTimeoutMs: 3_600_000,
                    contextSoftLimitTokens: 80_000,
                    contextHardLimitTokens: 100_000,
                    circuitBreaker: {
                      noProgressThreshold: 3,
                      sameErrorThreshold: 5,
                    },
                    model: resolvedModel,
                    effort: resolvedEffort,
                  },
                  circuitBreaker: createInitialCircuitBreakerState(),
                  iterations: [],
                  haltReason: null,
                  generatingPlan: false,
                  createdAt: now,
                  startedAt: null,
                  completedAt: null,
                  totalCostUsd: 0,
                  totalDurationMs: 0,
                  currentIterationConversationId: null,
                };
                return sess.workflow;
              },
            );

            logger.info("init_tool.create", {
              sessionName,
              objectiveLength: objective.length,
              taskCount: fixPlan.length,
            });

            // Broadcast SSE events for real-time UI update
            try {
              const pending = fixPlan.length;
              broadcast({
                type: "workflow-status",
                projectName,
                sessionName,
                workflowStatus: "planning",
                iterationCount: 0,
                maxIterations: 20,
                taskProgress: {
                  total: pending,
                  completed: 0,
                  skipped: 0,
                  pending,
                },
                haltReason: null,
              });
              broadcast({
                type: "workflow-fix-plan-updated",
                projectName,
                sessionName,
                fixPlan,
                source: "tool",
              });
            } catch {
              // fire-and-forget
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: `Ralph Loop workflow created successfully with objective: "${objective}" and ${fixPlan.length} tasks.\nThe user should visit the Ralph Loop page for this session to review the plan, make any adjustments, and confirm to start the workflow.`,
                },
              ],
            };
          } catch (error) {
            logger.error("init_tool.error", {
              sessionName,
              error: getErrorMessage(error),
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Failed to create workflow: ${getErrorMessage(error)}`,
                },
              ],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
