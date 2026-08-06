import TicketsPage from "@/features/tickets/TicketsPage";
import { resolveConfiguredBackendSelectionDefaults } from "@/lib/agent-backends/catalog";
import { readConfig } from "@/lib/config/loader";

// Request-time only: the config read below hits the live config.json, which a
// build-time prerender would both bake stale and reject outright whenever the
// on-disk shape trails the schema — startup migrations normalize that file
// strictly after the build (see src/lib/config/prerender-safety.test.ts).
export const dynamic = "force-dynamic";

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
