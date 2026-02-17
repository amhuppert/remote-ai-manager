import { notFound } from "next/navigation";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { computeDiff } from "@/lib/diff";
import SessionDetailPage from "./SessionDetailPage";
import type { TranscriptMessage } from "@/types";

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

  // Compute diff — safe to fail (returns empty)
  const diff = await computeDiff(sessionState.worktreePath);

  // Read conversation messages directly from session state
  const messages: TranscriptMessage[] = (sessionState.messages ?? []).map(
    (m) => ({
      role: m.role,
      content: m.content,
      timestamp: m.timestamp,
    }),
  );

  return (
    <SessionDetailPage
      projectName={name}
      session={sessionState}
      messages={messages}
      diff={diff}
    />
  );
}
