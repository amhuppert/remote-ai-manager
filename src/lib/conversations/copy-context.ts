/**
 * Builds XML context strings for the "Copy Context" clipboard button.
 * Used on both the session overview and conversation detail pages.
 */
import {
  deriveSessionPromptCountFromConvs,
  deriveSessionStatusFromParts,
  getCollaborationEnvelopeContribution,
} from "@/lib/sessions/derived";
import type { CopyContextSession } from "./copy-context-schemas";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function buildSessionContext(params: {
  projectName: string;
  sessionName: string;
  session: CopyContextSession;
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
    `  <status>${deriveSessionStatusFromParts({
      finished: session.finished,
      convStatuses: session.conversations.map(
        (conversation) => conversation.status,
      ),
      collabContribution: getCollaborationEnvelopeContribution({
        workflowEnvelopes: session.workflowEnvelopes,
      }),
    })}</status>`,
    `  <conversation-count>${session.conversations.length}</conversation-count>`,
    `  <total-prompts>${deriveSessionPromptCountFromConvs(session.conversations)}</total-prompts>`,
    `  <source>${session.source}</source>`,
    `  <creation-mode>${session.creationMode}</creation-mode>`,
    `  <finished>${session.finished}</finished>`,
  ];

  lines.push("</session-context>", "```");
  return lines.join("\n");
}

export function buildConversationContext(params: {
  projectName: string;
  sessionName: string;
  session: CopyContextSession;
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
    `  <agent-backend>${conv?.agentBackend ?? ""}</agent-backend>`,
    `  <agent-session-ref>${JSON.stringify(conv?.backendRef ?? null)}</agent-session-ref>`,
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

  lines.push("</conversation-context>", "```");
  return lines.join("\n");
}
