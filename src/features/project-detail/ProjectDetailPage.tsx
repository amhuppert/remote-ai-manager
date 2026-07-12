import ProjectDetailView from "./ProjectDetailView";
import { decodeRouteSegment } from "@/lib/shared/decode-route-segment";

interface ProjectDetailPageProps {
  params: Promise<{ name: string }>;
}

export default async function ProjectDetailPage({
  params,
}: ProjectDetailPageProps): Promise<React.JSX.Element> {
  const { name } = await params;
  return <ProjectDetailView projectName={decodeRouteSegment(name)} />;
}
