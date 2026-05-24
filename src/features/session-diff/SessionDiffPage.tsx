import SessionDiffViewer from "./components/SessionDiffViewer";

interface PageProps {
  params: Promise<{ name: string; session: string }>;
}

export default async function SessionDiffPage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { name, session } = await params;
  return (
    <SessionDiffViewer
      projectName={name}
      sessionName={decodeURIComponent(session)}
    />
  );
}
