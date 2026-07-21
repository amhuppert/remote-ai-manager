import ConversationsPage from "@/features/session/ConversationsPage";
import { resolveConfiguredBackendSelectionDefaults } from "@/lib/agent-backends/conversation-policy";
import { readConfig } from "@/lib/config/loader";

export const dynamic = "force-dynamic";

export default async function Page(): Promise<React.JSX.Element> {
  const config = await readConfig();
  return (
    <ConversationsPage
      backendDefaults={resolveConfiguredBackendSelectionDefaults(config)}
    />
  );
}
