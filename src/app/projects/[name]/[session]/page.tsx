import { notFound } from "next/navigation";
import { resolveProjectPath } from "@/lib/project-resolver";
import { getSession } from "@/lib/state";
import { computeDiff } from "@/lib/diff";
import { readTranscript } from "@/lib/transcript";
import SessionDetailPage from "./SessionDetailPage";

export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ name: string; session: string }>;
}

export default async function SessionPage({ params }: PageProps) {
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

  // Read transcript messages if transcript path is known (set via hooks)
  const messages = sessionState.transcriptPath
    ? await readTranscript(sessionState.transcriptPath)
    : [];

  return (
    <SessionDetailPage
      projectName={name}
      session={sessionState}
      messages={messages}
      diff={diff}
    />
  );
}
