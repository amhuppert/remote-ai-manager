import SessionDetailPage from "../SessionDetailPage";
import { readConfig } from "@/lib/config";

interface PageProps {
  params: Promise<{ name: string; session: string; conversationId: string }>;
  searchParams: Promise<{ autoFocus?: string }>;
}

export default async function ConversationPage({
  params,
  searchParams,
}: PageProps): Promise<React.JSX.Element> {
  const { name, session, conversationId } = await params;
  const { autoFocus } = await searchParams;
  const config = await readConfig();
  return (
    <SessionDetailPage
      projectName={name}
      sessionName={decodeURIComponent(session)}
      conversationId={conversationId}
      defaultModel={config.defaultModel}
      autoFocus={autoFocus === "true"}
    />
  );
}
