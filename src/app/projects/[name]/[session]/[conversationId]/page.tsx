import SessionDetailPage from "../SessionDetailPage";
import { readConfig } from "@/lib/config";

interface PageProps {
  params: Promise<{ name: string; session: string; conversationId: string }>;
}

export default async function ConversationPage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { name, session, conversationId } = await params;
  const config = await readConfig();
  return (
    <SessionDetailPage
      projectName={name}
      sessionName={decodeURIComponent(session)}
      conversationId={conversationId}
      defaultModel={config.defaultModel}
    />
  );
}
