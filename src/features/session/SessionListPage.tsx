import ConversationList from "@/features/session/conversation/ConversationList";
import { decodeRouteSegment } from "@/lib/shared/decode-route-segment";

interface PageProps {
  params: Promise<{ name: string; session: string }>;
}

export default async function SessionListPage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { name, session } = await params;
  return (
    <ConversationList
      projectName={decodeRouteSegment(name)}
      sessionName={decodeRouteSegment(session)}
    />
  );
}
