import ProjectDetailView from "./ProjectDetailView";

interface ProjectDetailPageProps {
  params: Promise<{ name: string }>;
}

export default async function ProjectDetailPage({
  params,
}: ProjectDetailPageProps): Promise<React.JSX.Element> {
  const { name } = await params;
  return <ProjectDetailView projectName={name} />;
}
