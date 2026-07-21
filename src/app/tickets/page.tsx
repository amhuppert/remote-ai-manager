import TicketsPage from "@/features/tickets/TicketsPage";
import { resolveConfiguredBackendSelectionDefaults } from "@/lib/agent-backends/conversation-policy";
import { readConfig } from "@/lib/config/loader";

// The split pane hosts the full ticket dossier, whose Start-work dialog needs
// the configured backend defaults — same server-side read as the detail page.
export default async function Page(): Promise<React.JSX.Element> {
  const config = await readConfig();
  return (
    <TicketsPage
      defaultAgentBackend={config.defaultAgentBackend}
      backendDefaults={resolveConfiguredBackendSelectionDefaults(config)}
    />
  );
}
