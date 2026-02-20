import SessionsList from "./SessionsList";

interface PageProps {
  params: Promise<{ name: string }>;
}

export default async function SessionsPage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { name } = await params;
  return <SessionsList projectName={name} />;
}
