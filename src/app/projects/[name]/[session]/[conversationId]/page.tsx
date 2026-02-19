import { notFound } from "next/navigation";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { getConversation, getSessionConversations } from "@/lib/conversations";
import { computeDiff } from "@/lib/diff";
import { getCommitLog } from "@/lib/git-operations";
import { readConversationMessages } from "@/lib/transcript";
import SessionDetailPage from "../SessionDetailPage";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ name: string; session: string; conversationId: string }>;
}

export default async function ConversationPage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { name, session: sessionName, conversationId } = await params;
  const decodedSessionName = decodeURIComponent(sessionName);

  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    notFound();
  }

  const sessionState = await getSession(projectPath, decodedSessionName);
  if (!sessionState) {
    notFound();
  }

  const conversation = await getConversation(
    projectPath,
    decodedSessionName,
    conversationId,
  );
  if (!conversation) {
    notFound();
  }

  // Compute diff — safe to fail (returns empty)
  const diff = await computeDiff(sessionState.worktreePath);

  // Fetch commit log — safe to fail (returns empty)
  const commits = await getCommitLog(sessionState.worktreePath);

  // All conversations for sidebar
  const conversations = await getSessionConversations(
    projectPath,
    decodedSessionName,
  );

  // Messages from Claude Code's transcript file
  const messages = await readConversationMessages(conversation.transcriptPath);

  return (
    <SessionDetailPage
      projectName={name}
      session={sessionState}
      messages={messages}
      diff={diff}
      commits={commits}
      conversationId={conversationId}
      conversations={conversations}
    />
  );
}
