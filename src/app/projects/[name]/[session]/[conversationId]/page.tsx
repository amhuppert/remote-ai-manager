import SessionDetailPage from "../SessionDetailPage";

interface PageProps {
  params: Promise<{ name: string; session: string; conversationId: string }>;
}

export default async function ConversationPage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { name, session, conversationId } = await params;
  return (
    <SessionDetailPage
      projectName={name}
      sessionName={decodeURIComponent(session)}
      conversationId={conversationId}
    />
  );
}
