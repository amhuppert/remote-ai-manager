import ConversationList from "./ConversationList";

interface PageProps {
  params: Promise<{ name: string; session: string }>;
}

export default async function SessionPage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { name, session } = await params;
  return (
    <ConversationList
      projectName={name}
      sessionName={decodeURIComponent(session)}
    />
  );
}
