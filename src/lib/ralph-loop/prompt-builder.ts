import type {
  FixPlanTask,
  ReportStatusInput,
  GitIterationMetrics,
} from "@/types";
import { getActiveTasksByGroup } from "./fix-plan-manager";

export interface BuildPromptParams {
  objective: string;
  fixPlan: FixPlanTask[];
  iterationNumber: number;
  maxIterations: number;
  previousIterationContext?: PreviousIterationContext;
}

export interface PreviousIterationContext {
  statusReport?: ReportStatusInput;
  errors?: string[];
  gitMetrics?: GitIterationMetrics;
}

/**
 * Build the prompt text for a loop iteration.
 * Returns a string containing the objective, task plan, iteration context,
 * and tool usage instructions.
 */
export function buildIterationPrompt(params: BuildPromptParams): string {
  const {
    objective,
    fixPlan,
    iterationNumber,
    maxIterations,
    previousIterationContext,
  } = params;

  const sections: string[] = [];

  // Header
  sections.push(
    `# Ralph Loop — Iteration ${iterationNumber} of ${maxIterations}`,
  );
  sections.push("");

  // Objective
  sections.push("## Objective");
  sections.push(objective);
  sections.push("");

  // Task Plan
  sections.push("## Task Plan");
  sections.push(buildTaskPlanSection(fixPlan));
  sections.push("");

  // Previous Iteration Context
  if (previousIterationContext) {
    sections.push("## Previous Iteration Summary");
    sections.push(buildPreviousContextSection(previousIterationContext));
    sections.push("");
  }

  // Tool Instructions
  sections.push("## Required Actions");
  sections.push(TOOL_INSTRUCTIONS);

  return sections.join("\n");
}

function buildTaskPlanSection(fixPlan: FixPlanTask[]): string {
  if (fixPlan.length === 0) {
    return "No tasks defined.";
  }

  const activeByGroup = getActiveTasksByGroup(fixPlan);
  const completedCount = fixPlan.filter((t) => t.status === "completed").length;
  const skippedCount = fixPlan.filter((t) => t.status === "skipped").length;
  const totalCount = fixPlan.length;

  const lines: string[] = [];
  lines.push(
    `Progress: ${completedCount + skippedCount}/${totalCount} tasks resolved (${completedCount} completed, ${skippedCount} skipped)`,
  );
  lines.push("");

  if (activeByGroup.size === 0) {
    lines.push("All tasks have been resolved.");
    return lines.join("\n");
  }

  lines.push(
    "**Remaining tasks by group (groups execute sequentially; tasks within a group are independent):**",
  );
  for (const [group, tasks] of activeByGroup) {
    lines.push("");
    lines.push(`### Group ${group}`);
    for (const task of tasks) {
      const statusLabel = task.status === "in_progress" ? " (in progress)" : "";
      lines.push(`- [${task.id}] ${task.description}${statusLabel}`);
    }
  }

  return lines.join("\n");
}

function buildPreviousContextSection(ctx: PreviousIterationContext): string {
  const lines: string[] = [];

  if (ctx.statusReport) {
    lines.push(
      `- Status: ${ctx.statusReport.status} (${ctx.statusReport.work_type})`,
    );
    lines.push(`- Summary: ${ctx.statusReport.work_summary}`);
    if (ctx.statusReport.exit_signal) {
      lines.push("- Exit signal: true (you indicated work was complete)");
    }
  }

  if (ctx.gitMetrics && ctx.gitMetrics.filesChanged > 0) {
    lines.push(
      `- Files changed: ${ctx.gitMetrics.filesChanged} (+${ctx.gitMetrics.linesAdded}/-${ctx.gitMetrics.linesRemoved})`,
    );
  }

  if (ctx.errors?.length) {
    lines.push("- Errors from previous iteration:");
    for (const err of ctx.errors.slice(0, 3)) {
      lines.push(`  - ${err}`);
    }
  }

  return lines.length > 0
    ? lines.join("\n")
    : "No context from previous iteration.";
}

const TOOL_INSTRUCTIONS = `You have two special tools available for this workflow iteration:

### report_status
Call this tool **at the end of your iteration** with an honest assessment of your progress.

Input:
- \`status\`: "in_progress" | "complete" | "blocked"
- \`exit_signal\`: true if you believe the overall objective is complete, false otherwise
- \`work_summary\`: Brief description of what you accomplished this iteration
- \`work_type\`: "implementation" | "testing" | "documentation" | "refactoring"

### update_fix_plan
Call this tool **whenever** you complete a task, discover a new task, or determine a task is unnecessary.

Input:
- \`completedTaskIds\`: Array of task IDs you completed (from the task plan above)
- \`skippedTasks\`: Array of { taskId, reason } for tasks that became unnecessary
- \`newTasks\`: Array of { description, group } for newly discovered tasks

**Important guidelines:**
- Focus on tasks in the current group (lowest group number with unresolved tasks). Do not start tasks from a later group until all current-group tasks are resolved.
- When adding new tasks, assign the current group number if the task is independent, or a higher group number if it depends on other unfinished tasks.
- Call \`update_fix_plan\` as soon as you complete or skip a task — don't wait until the end.
- Call \`report_status\` once at the end of your work with an honest assessment.
- If you encounter permission errors or are blocked, report status as "blocked".
- Make your best judgment and proceed autonomously — do not ask for user input.
- **Context limits**: This iteration has a context token budget. If tool responses include a "CONTEXT LIMIT APPROACHING" warning, immediately wrap up: commit or save your current work, call \`update_fix_plan\` for any completed/skipped tasks, and call \`report_status\`. Do not start new tasks after seeing this warning. Your work will be preserved and continued in the next iteration.`;
