/**
 * AI-powered task plan generator for the Ralph Loop workflow.
 *
 * Reads the most recent conversation transcript from the session to build
 * context, then runs a single SDK query with a planning-focused prompt
 * and a custom submit_plan MCP tool to capture structured output.
 */

import { query } from "@anthropic-ai/claude-agent-sdk";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { getErrorMessage } from "@/lib/errors";
import type { SessionState, RalphLoopWorkflow, FixPlanTask } from "@/types";
import { buildChildEnv } from "../child-env";
import { mutateSession } from "../state";
import { createLogger } from "../logging";
import { readConversationMessages } from "../transcript";
import { broadcast } from "../sse-broadcaster";
import { getProjectDisplayName } from "../project-resolver";
import { createTask } from "./fix-plan-manager";

const logger = createLogger("ralph-loop");

// ============================================================
// Public API
// ============================================================

export interface GeneratePlanParams {
  projectPath: string;
  session: SessionState;
  workflow: RalphLoopWorkflow;
}

/**
 * Fire-and-forget plan generation.
 * Reads session context and uses Claude to suggest tasks.
 * Does NOT acquire the session lock (read-only context operation).
 */
export function dispatchPlanGeneration(params: GeneratePlanParams): void {
  const { projectPath, session } = params;
  const sessionName = session.sessionName;
  const projectName = getProjectDisplayName(projectPath);

  void generatePlan(projectPath, sessionName, projectName, session).catch(
    async (err) => {
      logger.error("plan_generator.fatal", {
        sessionName,
        error: getErrorMessage(err),
      });
      // Ensure the generating flag is cleared even on unexpected errors
      try {
        await mutateSession(
          projectPath,
          sessionName,
          "planGenerator.clearGenerating",
          (sess) => {
            if (sess.workflow) sess.workflow.generatingPlan = false;
            return null;
          },
        );
      } catch {
        // best-effort
      }
    },
  );
}

/**
 * Generate tasks and return them without mutating state.
 * Used by the XState actor implementation.
 */
export async function generatePlanTasks(params: {
  projectPath: string;
  sessionName: string;
  worktreePath: string;
  objective: string;
}): Promise<FixPlanTask[]> {
  const { projectPath, sessionName, worktreePath, objective } = params;
  const { getSession } = await import("@/lib/state");

  const session = await getSession(projectPath, sessionName);
  if (!session) return [];

  const context = await gatherSessionContext(session);
  const prompt = buildPlanningPrompt(objective, context);

  let generatedTasks: Array<{ description: string; group: number }> = [];

  const planToolServer = createSdkMcpServer({
    name: "ralph-plan-generator",
    version: "1.0.0",
    tools: [
      tool(
        "submit_plan",
        "Submit the generated task plan. Call this exactly once with the list of tasks.",
        {
          tasks: z
            .array(
              z.object({
                description: z
                  .string()
                  .describe("Clear, actionable task description"),
                group: z
                  .number()
                  .int()
                  .min(1)
                  .describe(
                    "Execution group (1-based). Tasks in the same group are independent and can run in parallel. Lower groups execute first.",
                  ),
              }),
            )
            .describe("Array of tasks for the fix plan"),
        },
        async (args) => {
          generatedTasks = args.tasks;
          return {
            content: [
              {
                type: "text" as const,
                text: `Plan submitted with ${args.tasks.length} tasks.`,
              },
            ],
          };
        },
      ),
    ],
  });

  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), 600_000);

  try {
    const q = query({
      prompt,
      options: {
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: `<objective>${objective}</objective>`,
        },
        settingSources: ["user", "project", "local"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        cwd: worktreePath,
        maxTurns: undefined,
        persistSession: false,
        abortController,
        env: { ...buildChildEnv(), CLAUDECODE: "" },
        mcpServers: { "ralph-plan-generator": planToolServer },
        canUseTool: async (toolName: string) => {
          if (toolName === "AskUserQuestion") {
            return {
              behavior: "deny" as const,
              message:
                "Plan generation is automated. Submit the plan directly.",
            };
          }
          return { behavior: "allow" as const, updatedInput: {} };
        },
      },
    });

    for await (const msg of q) {
      void msg;
    }
  } catch (err) {
    if (!abortController.signal.aborted) {
      logger.error("plan_generator.tasks_error", {
        sessionName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  return generatedTasks.map((t) =>
    createTask({ description: t.description, group: t.group }),
  );
}

// ============================================================
// Implementation
// ============================================================

async function generatePlan(
  projectPath: string,
  sessionName: string,
  projectName: string,
  session: SessionState,
): Promise<void> {
  const workflow = session.workflow;
  if (!workflow) return;

  logger.info("plan_generator.start", {
    sessionName,
    objective: workflow.objective,
  });

  // Gather context from most recent conversation transcript
  const context = await gatherSessionContext(session);

  // Build the planning prompt
  const prompt = buildPlanningPrompt(workflow.objective, context);

  // Capture plan via MCP tool
  let generatedTasks: Array<{
    description: string;
    group: number;
  }> = [];

  const planToolServer = createSdkMcpServer({
    name: "ralph-plan-generator",
    version: "1.0.0",
    tools: [
      tool(
        "submit_plan",
        "Submit the generated task plan. Call this exactly once with the list of tasks.",
        {
          tasks: z
            .array(
              z.object({
                description: z
                  .string()
                  .describe("Clear, actionable task description"),
                group: z
                  .number()
                  .int()
                  .min(1)
                  .describe(
                    "Execution group (1-based). Tasks in the same group are independent and can run in parallel. Lower groups execute first.",
                  ),
              }),
            )
            .describe("Array of tasks for the fix plan"),
        },
        async (args) => {
          generatedTasks = args.tasks;
          return {
            content: [
              {
                type: "text" as const,
                text: `Plan submitted with ${args.tasks.length} tasks.`,
              },
            ],
          };
        },
      ),
    ],
  });

  // Execute with timeout (no turn limit — let the SDK explore freely)
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), 600_000); // 10 min

  try {
    const q = query({
      prompt,
      options: {
        systemPrompt: {
          type: "preset",
          preset: "claude_code",
          append: `<objective>${workflow.objective}</objective>`,
        },
        settingSources: ["user", "project", "local"],
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        cwd: session.worktreePath,
        maxTurns: undefined,
        persistSession: false,
        abortController,
        env: { ...buildChildEnv(), CLAUDECODE: "" },
        mcpServers: { "ralph-plan-generator": planToolServer },
        canUseTool: async (toolName: string) => {
          if (toolName === "AskUserQuestion") {
            return {
              behavior: "deny" as const,
              message:
                "Plan generation is automated. Submit the plan directly.",
            };
          }
          return { behavior: "allow" as const, updatedInput: {} };
        },
      },
    });

    // Consume the stream
    for await (const msg of q) {
      void msg; // Just consume — we only care about the tool call result
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      logger.warn("plan_generator.timeout", { sessionName });
    } else {
      logger.error("plan_generator.error", {
        sessionName,
        error: getErrorMessage(err),
      });
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  // Persist generated tasks and clear generating flag
  if (generatedTasks.length > 0) {
    // Append to existing tasks (don't replace) and clear generatingPlan flag
    const newTasks: FixPlanTask[] = generatedTasks.map((t) =>
      createTask({
        description: t.description,
        group: t.group,
      }),
    );

    const updatedPlan = await mutateSession(
      projectPath,
      sessionName,
      "planGenerator.appendTasks",
      (sess) => {
        if (!sess.workflow) return null;
        sess.workflow.generatingPlan = false;
        sess.workflow.fixPlan = [...sess.workflow.fixPlan, ...newTasks];
        return sess.workflow.fixPlan;
      },
    );

    logger.info("plan_generator.complete", {
      sessionName,
      tasksGenerated: newTasks.length,
    });

    // Broadcast plan update
    if (updatedPlan) {
      try {
        broadcast({
          type: "workflow-fix-plan-updated",
          projectName,
          sessionName,
          fixPlan: updatedPlan,
          source: "tool",
        });
      } catch {
        // fire-and-forget
      }
    }
  } else {
    // No tasks generated — clear the flag anyway
    await mutateSession(
      projectPath,
      sessionName,
      "planGenerator.clearGenerating",
      (sess) => {
        if (sess.workflow) sess.workflow.generatingPlan = false;
        return null;
      },
    );
    logger.warn("plan_generator.no_tasks", { sessionName });
  }
}

// ============================================================
// Helpers
// ============================================================

async function gatherSessionContext(session: SessionState): Promise<string> {
  // Find the most recent non-iteration conversation with a transcript
  const candidates = [...session.conversations]
    .filter((c) => c.role !== "iteration" && c.transcriptPath)
    .sort(
      (a, b) =>
        new Date(b.lastActivityAt).getTime() -
        new Date(a.lastActivityAt).getTime(),
    );

  if (candidates.length === 0) {
    return "No previous conversation context available.";
  }

  const latest = candidates[0]!;
  const messages = await readConversationMessages(latest.transcriptPath);

  if (messages.length === 0) {
    return "No previous conversation context available.";
  }

  // Take the last few messages for context (avoid prompt bloat)
  const recentMessages = messages.slice(-6);
  const contextParts: string[] = [];

  for (const msg of recentMessages) {
    const role = msg.role === "user" ? "User" : "Assistant";
    const textContent = msg.content
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    if (textContent) {
      contextParts.push(`${role}: ${textContent.slice(0, 500)}`);
    }
  }

  return contextParts.join("\n\n");
}

function buildPlanningPrompt(
  objective: string,
  sessionContext: string,
): string {
  return `You are a planning assistant for an autonomous coding workflow.

## Objective
${objective}

## Session Context
${sessionContext}

## Instructions
Analyze the objective and any available context to create a structured task plan.
Break the work into discrete, actionable tasks. Each task should be:
- Specific and self-contained
- Achievable in a single iteration (roughly 10-30 minutes of work)
- Assigned to an execution group based on dependencies

Use the \`submit_plan\` tool to submit your task plan. Call it exactly once with all tasks.

Group guidelines:
- **Group 1**: Foundation tasks with no dependencies — core setup, schema definitions, initial implementations
- **Group 2**: Tasks that depend on group 1 — features built on the foundation
- **Group 3+**: Tasks that depend on previous groups — integration, polish, documentation
- Tasks within the same group MUST be independent of each other (they could theoretically run in parallel)
- Minimize the number of groups while respecting real dependencies

Do not include tasks for "review" or "testing as a whole" — each implementation task should include its own testing.`;
}
