import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getSession, mutateSession } from "@/lib/state";
import { broadcast } from "@/lib/sse-broadcaster";
import { createLogger } from "@/lib/logging";
import { createInitialCircuitBreakerState } from "./circuit-breaker";
import { dispatchPlanGeneration } from "./plan-generator";

const logger = createLogger("ralph-loop");

export interface InitToolContext {
  projectPath: string;
  sessionName: string;
  projectName: string;
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
        "Initialize a Ralph Loop autonomous workflow for this session. Call this when the user wants to start an iterative, autonomous coding workflow. Provide a clear objective summarizing the development goal.",
        {
          objective: z
            .string()
            .min(1)
            .describe(
              "A clear description of the development objective for the Ralph Loop workflow",
            ),
        },
        async (args) => {
          const { objective } = args;
          const { projectPath, sessionName, projectName } = context;

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

            // Create the workflow via mutateSession
            const now = new Date().toISOString();
            const workflow = await mutateSession(
              projectPath,
              sessionName,
              "initTool.createWorkflow",
              (sess) => {
                sess.workflow = {
                  status: "planning",
                  objective,
                  fixPlan: [],
                  config: {
                    maxIterations: 20,
                    iterationTimeoutMs: 3_600_000,
                    contextSoftLimitTokens: 160_000,
                    contextHardLimitTokens: 180_000,
                    circuitBreaker: {
                      noProgressThreshold: 3,
                      sameErrorThreshold: 5,
                    },
                  },
                  circuitBreaker: createInitialCircuitBreakerState(),
                  iterations: [],
                  haltReason: null,
                  generatingPlan: true,
                  createdAt: now,
                  startedAt: null,
                  completedAt: null,
                  totalCostUsd: 0,
                  totalDurationMs: 0,
                };
                return sess.workflow;
              },
            );

            logger.info("init_tool.create", {
              sessionName,
              objectiveLength: objective.length,
            });

            // Broadcast SSE event for real-time UI update
            try {
              broadcast({
                type: "workflow-status",
                projectName,
                sessionName,
                workflowStatus: "planning",
                iterationCount: 0,
                maxIterations: 20,
                taskProgress: {
                  total: 0,
                  completed: 0,
                  skipped: 0,
                  pending: 0,
                },
                haltReason: null,
              });
            } catch {
              // fire-and-forget
            }

            // Dispatch plan generation fire-and-forget
            if (workflow) {
              const freshSession = await getSession(projectPath, sessionName);
              if (freshSession && freshSession.workflow) {
                dispatchPlanGeneration({
                  projectPath,
                  session: freshSession,
                  workflow: freshSession.workflow,
                });
              }
            }

            return {
              content: [
                {
                  type: "text" as const,
                  text: `Ralph Loop workflow created successfully with objective: "${objective}".\nPlan generation is in progress. The user should visit the Ralph Loop page for this session to review the generated plan, make any adjustments, and confirm to start the workflow.`,
                },
              ],
            };
          } catch (error) {
            logger.error("init_tool.error", {
              sessionName,
              error: error instanceof Error ? error.message : String(error),
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Failed to create workflow: ${error instanceof Error ? error.message : String(error)}`,
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
