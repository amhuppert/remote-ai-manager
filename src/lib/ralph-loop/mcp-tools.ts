import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  reportStatusInputSchema,
  updateFixPlanInputSchema,
} from "@/lib/schemas";
import { getErrorMessage } from "@/lib/errors";
import type { ReportStatusInput, UpdateFixPlanInput } from "@/types";

export interface ToolContext {
  projectPath: string;
  sessionName: string;
  iterationNumber: number;
  isWindingDown: () => boolean;
  onStatusReport: (report: ReportStatusInput) => void;
  onFixPlanUpdate: (update: UpdateFixPlanInput) => Promise<void>;
}

/**
 * Create an in-process MCP server with the Ralph Loop custom tools.
 * Recreated per iteration with fresh context references.
 */
export function createToolServer(
  context: ToolContext,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "ralph-loop",
    version: "1.0.0",
    tools: [
      tool(
        "report_status",
        "Report the status and progress of the current iteration. Call this at the end of your work with an honest assessment.",
        {
          status: z
            .enum(["in_progress", "complete", "blocked"])
            .describe(
              "Current iteration status: in_progress if still working, complete if the objective is done, blocked if you cannot proceed",
            ),
          exit_signal: z
            .boolean()
            .describe(
              "Set to true ONLY when ALL tasks in the plan are resolved (completed or skipped) AND you have verified the work is fully integrated. If tasks remain pending, this MUST be false even if you personally finished your iteration's work. Setting exit_signal prematurely causes the loop to end with incomplete work.",
            ),
          work_summary: z
            .string()
            .describe(
              "Brief description of what you accomplished this iteration",
            ),
          work_type: z
            .enum(["implementation", "testing", "documentation", "refactoring"])
            .describe("The primary type of work performed this iteration"),
        },
        async (args) => {
          const parsed = reportStatusInputSchema.safeParse(args);
          if (!parsed.success) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Validation error: ${parsed.error.message}. Please correct and retry.`,
                },
              ],
              isError: true,
            };
          }
          context.onStatusReport(parsed.data);
          const statusText = `Status report recorded: ${parsed.data.status} (exit_signal: ${parsed.data.exit_signal})`;
          return {
            content: [
              {
                type: "text" as const,
                text: context.isWindingDown()
                  ? `${statusText}\n\n${CONTEXT_LIMIT_WARNING}`
                  : statusText,
              },
            ],
          };
        },
      ),
      tool(
        "update_fix_plan",
        "Update the task plan: mark tasks as completed, skip tasks with a reason, or add newly discovered tasks. Call this whenever tasks are completed, discovered, or determined unnecessary.",
        {
          completedTaskIds: z
            .array(z.string())
            .optional()
            .describe("Array of task IDs that have been completed"),
          skippedTasks: z
            .array(
              z.object({
                taskId: z.string(),
                reason: z.string(),
              }),
            )
            .optional()
            .describe("Array of tasks to skip, each with a taskId and reason"),
          newTasks: z
            .array(
              z.object({
                description: z.string(),
                group: z
                  .number()
                  .int()
                  .min(1)
                  .describe(
                    "Group number. Tasks in the same group are independent. Lower groups execute first.",
                  ),
              }),
            )
            .optional()
            .describe("Array of newly discovered tasks to add to the plan"),
        },
        async (args) => {
          const parsed = updateFixPlanInputSchema.safeParse(args);
          if (!parsed.success) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Validation error: ${parsed.error.message}. Please correct and retry.`,
                },
              ],
              isError: true,
            };
          }

          try {
            await context.onFixPlanUpdate(parsed.data);
            const summary: string[] = [];
            if (parsed.data.completedTaskIds?.length) {
              summary.push(
                `${parsed.data.completedTaskIds.length} task(s) completed`,
              );
            }
            if (parsed.data.skippedTasks?.length) {
              summary.push(
                `${parsed.data.skippedTasks.length} task(s) skipped`,
              );
            }
            if (parsed.data.newTasks?.length) {
              summary.push(`${parsed.data.newTasks.length} task(s) added`);
            }
            const planText = `Plan updated: ${summary.join(", ") || "no changes"}`;
            return {
              content: [
                {
                  type: "text" as const,
                  text: context.isWindingDown()
                    ? `${planText}\n\n${CONTEXT_LIMIT_WARNING}`
                    : planText,
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Error updating plan: ${getErrorMessage(error)}`,
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

const CONTEXT_LIMIT_WARNING =
  "⚠️ CONTEXT LIMIT APPROACHING: You are nearing the context token limit for this iteration. Wrap up your current task now — call update_fix_plan for any completed/skipped tasks, then call report_status. The iteration will be forcefully ended soon.";
