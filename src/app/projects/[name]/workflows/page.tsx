import { readConfig } from "@/lib/config";
import ConnectedWorkflowBuilderPage from "./ConnectedWorkflowBuilderPage";

interface PageProps {
  params: Promise<{ name: string }>;
}

export default async function WorkflowBuilderPage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { name } = await params;
  const config = await readConfig();
  return (
    <ConnectedWorkflowBuilderPage
      projectName={name}
      defaultModel={config.defaultModel}
      codexConfig={config.codex}
    />
  );
}
