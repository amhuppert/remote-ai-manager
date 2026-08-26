import { DesktopModelSelectionControls } from "@/components/session/prompt/ModelSelectionControls";
import { getConfiguredBackendModelCatalog } from "@/lib/agent-backends/catalog";
import type { GraphWorkflowAgentConfig } from "@/lib/workflow-graph/config-schemas";

import { ConfigField } from "../../components/ConfigField";

export type CodexAgentValue = Extract<
  GraphWorkflowAgentConfig,
  { backend: "codex" }
>;

export function CodexAgentSubfields({
  agent,
  onAgentChange,
}: {
  agent: CodexAgentValue;
  onAgentChange: (agent: CodexAgentValue) => void;
}): React.JSX.Element {
  return (
    <ConfigField
      label="Codex model selection"
      fieldPath="workflowDefaults.contextValidator.assignments.0.agent.modelSelection"
      isDefault={false}
      isModified={false}
    >
      <DesktopModelSelectionControls
        catalog={getConfiguredBackendModelCatalog(
          agent.backend,
          agent.modelSelection,
        )}
        selection={agent.modelSelection}
        onSelectionChange={(modelSelection) =>
          onAgentChange({ ...agent, modelSelection })
        }
      />
    </ConfigField>
  );
}
