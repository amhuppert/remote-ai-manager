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
import type { SessionState, RalphLoopWorkflow, FixPlanTask } from "@/types";
import { mutateSession } from "../state";
import { createLogger } from "../logging";
import { readConversationMessages } from "../transcript";
import { broadcast } from "../sse-broadcaster";
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
  const projectName = projectPath.split("/").pop() ?? projectPath;

  void generatePlan(projectPath, sessionName, projectName, session).catch(
    (err) => {
      logger.error("plan_generator.fatal", {
        sessionName,
        error: err instanceof Error ? err.message : String(err),
      });
    },
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
    priority: "high" | "medium" | "low";
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
                priority: z
                  .enum(["high", "medium", "low"])
                  .describe("Task priority"),
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

  // Execute with short timeout and low max turns
  const abortController = new AbortController();
  const timeoutHandle = setTimeout(() => abortController.abort(), 120_000); // 2 min

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
        maxTurns: 3,
        persistSession: false,
        abortController,
        env: { ...process.env, CLAUDECODE: "" },
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
    for await (const _ of q) {
      // Just consume — we only care about the tool call result
    }
  } catch (err) {
    if (abortController.signal.aborted) {
      logger.warn("plan_generator.timeout", { sessionName });
    } else {
      logger.error("plan_generator.error", {
        sessionName,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    clearTimeout(timeoutHandle);
  }

  // Persist generated tasks
  if (generatedTasks.length > 0) {
    // Append to existing tasks (don't replace)
    const newTasks: FixPlanTask[] = generatedTasks.map((t) =>
      createTask({
        description: t.description,
        priority: t.priority,
      }),
    );

    const updatedPlan = await mutateSession(
      projectPath,
      sessionName,
      "planGenerator.appendTasks",
      (sess) => {
        if (!sess.workflow) return null;
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
- Ordered by dependency and priority

Use the \`submit_plan\` tool to submit your task plan. Call it exactly once with all tasks.

Priority guidelines:
- **high**: Core functionality, blocking other tasks, critical path items
- **medium**: Important but not blocking, supporting functionality
- **low**: Nice-to-have, cleanup, documentation, polish

Do not include tasks for "review" or "testing as a whole" — each implementation task should include its own testing.`;
}
