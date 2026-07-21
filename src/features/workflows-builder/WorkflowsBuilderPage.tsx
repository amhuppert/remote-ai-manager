import ConnectedWorkflowBuilderPage from "./components/ConnectedWorkflowBuilderPage";

interface WorkflowsBuilderPageProps {
  params: Promise<{ name: string }>;
  searchParams?: Promise<{ definition?: string }>;
}

export default async function WorkflowsBuilderPage({
  params,
  searchParams,
}: WorkflowsBuilderPageProps): Promise<React.JSX.Element> {
  const { name } = await params;
  const { definition } = (await searchParams) ?? {};
  return (
    <ConnectedWorkflowBuilderPage
      scope={{ kind: "project", projectName: name }}
      initialWorkflowId={definition ?? null}
    />
  );
}
