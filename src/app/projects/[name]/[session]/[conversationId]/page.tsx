import ConversationDetailPage from "@/features/session/SessionPage";
import { readConfig } from "@/lib/config/loader";

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
    <ConversationDetailPage
      projectName={name}
      sessionName={decodeURIComponent(session)}
      conversationId={conversationId}
      defaultModel={config.defaultModel}
      defaultEffort={config.defaultEffort}
      autoFocus={autoFocus === "true"}
    />
  );
}
