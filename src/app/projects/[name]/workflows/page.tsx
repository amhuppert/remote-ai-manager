import { readConfig } from "@/lib/config";
import {
  codexModelSchema,
  codexReasoningEffortSchema,
  getDefaultCodexModel,
} from "@/lib/schemas";
import type { GraphWorkflowAgentConfig } from "@/types";
import ConnectedWorkflowBuilderPage from "./ConnectedWorkflowBuilderPage";

interface PageProps {
  params: Promise<{ name: string }>;
}

export function buildDefaultImplementerConfig(
  config: Awaited<ReturnType<typeof readConfig>>,
): GraphWorkflowAgentConfig {
  if (config.defaultAgentBackend === "codex") {
    const modelResult = codexModelSchema.safeParse(config.codex?.model);
    const effortResult = codexReasoningEffortSchema.safeParse(
      config.codex?.reasoningEffort,
    );
    return {
      backend: "codex",
      model: modelResult.success ? modelResult.data : getDefaultCodexModel(),
      reasoningEffort: effortResult.success ? effortResult.data : "high",
    };
  }
  return {
    backend: "claude",
    model: config.defaultModel,
    reasoningEffort: "medium",
  };
}

export default async function WorkflowBuilderPage({
  params,
}: PageProps): Promise<React.JSX.Element> {
  const { name } = await params;
  const config = await readConfig();
  return (
    <ConnectedWorkflowBuilderPage
      projectName={name}
      defaultImplementerConfig={buildDefaultImplementerConfig(config)}
      codexConfig={config.codex}
    />
  );
}
