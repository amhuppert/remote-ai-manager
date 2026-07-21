import ProjectDetailView from "./ProjectDetailView";
import { decodeRouteSegment } from "@/lib/shared/decode-route-segment";
import { readConfig } from "@/lib/config/loader";
import { resolveConfiguredBackendSelectionDefaults } from "@/lib/agent-backends/catalog";

interface ProjectDetailPageProps {
  params: Promise<{ name: string }>;
}

export default async function ProjectDetailPage({
  params,
}: ProjectDetailPageProps): Promise<React.JSX.Element> {
  const { name } = await params;
  const config = await readConfig();
  return (
    <ProjectDetailView
      projectName={decodeRouteSegment(name)}
      defaultAgentBackend={config.defaultAgentBackend}
      backendDefaults={resolveConfiguredBackendSelectionDefaults(config)}
    />
  );
}
