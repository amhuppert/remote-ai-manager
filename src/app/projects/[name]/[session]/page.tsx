import { notFound } from "next/navigation";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import {
  getSessionConversations,
  discoverAndImportConversations,
} from "@/lib/conversations";
import ConversationList from "./ConversationList";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ name: string; session: string }>;
}

export default async function SessionPage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { name, session: sessionName } = await params;
  const decodedSessionName = decodeURIComponent(sessionName);

  const projectPath = await resolveProjectPath(name);
  if (!projectPath) {
    notFound();
  }

  const sessionState = await getSession(projectPath, decodedSessionName);
  if (!sessionState) {
    notFound();
  }

  // Auto-import CLI-created conversations on page load
  await discoverAndImportConversations(projectPath, sessionState);

  // Fetch conversations (most recent first)
  const conversations = await getSessionConversations(
    projectPath,
    decodedSessionName,
  );

  return (
    <ConversationList
      projectName={name}
      session={sessionState}
      conversations={conversations}
    />
  );
}
