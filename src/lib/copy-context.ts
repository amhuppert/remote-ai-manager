/**
 * Builds XML context strings for the "Copy Context" clipboard button.
 * Used on both the session overview and conversation detail pages.
 */
import type { SessionState, GraphWorkflowExecution } from "@/types";
import {
  deriveSessionStatus,
  deriveSessionPromptCount,
} from "@/lib/session-derived";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildSessionContext(params: {
  projectName: string;
  sessionName: string;
  session: SessionState;
}): string {
  const { projectName, sessionName, session } = params;
  const lines: string[] = [
    "```xml",
    "<session-context>",
    `  <project>${projectName}</project>`,
    `  <session>${sessionName}</session>`,
    `  <branch>${session.branchName}</branch>`,
    `  <worktree>${session.worktreePath}</worktree>`,
    `  <created>${session.createdAt}</created>`,
    `  <status>${deriveSessionStatus(session)}</status>`,
    `  <conversation-count>${session.conversations.length}</conversation-count>`,
    `  <total-prompts>${deriveSessionPromptCount(session)}</total-prompts>`,
    `  <source>${session.source}</source>`,
    `  <creation-mode>${session.creationMode}</creation-mode>`,
    `  <finished>${session.finished}</finished>`,
  ];

  if (session.graphWorkflowExecution) {
    appendGraphWorkflowLines(lines, session.graphWorkflowExecution, "  ");
  }

  lines.push("</session-context>", "```");
  return lines.join("\n");
}

export function buildConversationContext(params: {
  projectName: string;
  sessionName: string;
  session: SessionState;
  conversationId: string;
}): string {
  const { projectName, sessionName, session, conversationId } = params;
  const conv = session.conversations.find((c) => c.id === conversationId);

  const lines: string[] = [
    "```xml",
    "<conversation-context>",
    `  <project>${projectName}</project>`,
    `  <session>${sessionName}</session>`,
    `  <branch>${session.branchName}</branch>`,
    `  <worktree>${session.worktreePath}</worktree>`,
    `  <created>${session.createdAt}</created>`,
    `  <conversation-id>${conversationId}</conversation-id>`,
    `  <claude-session-id>${conv?.claudeSessionId ?? ""}</claude-session-id>`,
    `  <status>${conv?.status ?? ""}</status>`,
    `  <prompt-count>${conv?.promptCount ?? 0}</prompt-count>`,
    `  <last-activity>${conv?.lastActivityAt ?? ""}</last-activity>`,
    `  <transcript-path>${conv?.transcriptPath ?? ""}</transcript-path>`,
    `  <total-cost-usd>${conv?.totalCostUsd ?? ""}</total-cost-usd>`,
    `  <total-duration-ms>${conv?.totalDurationMs ?? ""}</total-duration-ms>`,
    `  <total-turns>${conv?.totalTurns ?? ""}</total-turns>`,
    `  <source>${conv?.source ?? ""}</source>`,
    `  <session-source>${session.source}</session-source>`,
    `  <creation-mode>${session.creationMode}</creation-mode>`,
  ];

  if (conv?.role) {
    lines.push(`  <role>${conv.role}</role>`);
  }

  if (conv?.contextTokens != null) {
    lines.push(`  <context-tokens>${conv.contextTokens}</context-tokens>`);
  }
  if (conv?.contextWindowMax != null) {
    lines.push(
      `  <context-window-max>${conv.contextWindowMax}</context-window-max>`,
    );
  }

  if (session.graphWorkflowExecution) {
    appendGraphWorkflowLines(
      lines,
      session.graphWorkflowExecution,
      "  ",
      conversationId,
    );
  }

  lines.push("</conversation-context>", "```");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function appendGraphWorkflowLines(
  lines: string[],
  execution: GraphWorkflowExecution,
  indent: string,
  conversationId?: string,
): void {
  const def = execution.workingDefinition;

  lines.push(`${indent}<graph-workflow>`);
  lines.push(`${indent}  <execution-id>${execution.id}</execution-id>`);
  lines.push(
    `${indent}  <workflow-status>${execution.status}</workflow-status>`,
  );
  lines.push(
    `${indent}  <seed-definition-id>${execution.seedDefinitionId}</seed-definition-id>`,
  );
  lines.push(
    `${indent}  <seed-definition-revision>${execution.seedDefinitionRevision}</seed-definition-revision>`,
  );

  // Active context info
  if (execution.activeContextId) {
    lines.push(
      `${indent}  <active-context-id>${execution.activeContextId}</active-context-id>`,
    );
    const ctxDef = def.executionContexts.find(
      (c) => c.id === execution.activeContextId,
    );
    if (ctxDef) {
      lines.push(
        `${indent}  <active-context-title>${ctxDef.title}</active-context-title>`,
      );
    }

    const ctxState = execution.contextStates[execution.activeContextId];
    if (ctxState) {
      lines.push(
        `${indent}  <context-iteration-count>${ctxState.iterationCount}</context-iteration-count>`,
      );
      lines.push(
        `${indent}  <context-completed-tasks>${ctxState.completedTaskCount}</context-completed-tasks>`,
      );
      lines.push(
        `${indent}  <context-total-tasks>${ctxState.totalTaskCount}</context-total-tasks>`,
      );
    }
  }

  // Overall progress
  const completedContexts = Object.values(execution.contextStates).filter(
    (cs) => cs.status === "completed",
  ).length;
  lines.push(
    `${indent}  <total-contexts>${def.executionContexts.length}</total-contexts>`,
  );
  lines.push(
    `${indent}  <completed-contexts>${completedContexts}</completed-contexts>`,
  );

  // Halt reason
  if (execution.haltReason) {
    lines.push(
      `${indent}  <halt-reason>${execution.haltReason.type}</halt-reason>`,
    );
  }

  // Conversation-to-task linkage (conversation page only)
  if (conversationId) {
    const linkedTask = Object.values(execution.taskStates).find(
      (ts) => ts.lastConversationId === conversationId,
    );
    if (linkedTask) {
      lines.push(
        `${indent}  <linked-task-id>${linkedTask.taskId}</linked-task-id>`,
      );
      const taskDef = def.tasks.find((t) => t.id === linkedTask.taskId);
      if (taskDef) {
        lines.push(
          `${indent}  <linked-task-title>${taskDef.title}</linked-task-title>`,
        );
      }
    }
  }

  lines.push(`${indent}</graph-workflow>`);
}
