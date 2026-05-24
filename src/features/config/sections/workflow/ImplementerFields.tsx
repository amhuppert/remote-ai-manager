import ModelSelector from "@/components/ModelSelector";
import ReasoningLevelSelector from "@/components/ReasoningLevelSelector";
import type { EffortLevel } from "@/lib/agent-backends/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import type { GraphWorkflowAgentConfig } from "@/lib/workflows/schemas";
import { ConfigField } from "../../components/ConfigField";
import { ConfigPillGroup } from "../../components/ConfigPillGroup";
import { getEffortOptionsForBackend } from "../../config-helpers";

export function ImplementerFields({
  value,
  onChange,
}: {
  value: GraphWorkflowAgentConfig;
  onChange: (v: GraphWorkflowAgentConfig) => void;
}) {
  const backend = value.backend;
  const effortOptions = getEffortOptionsForBackend(backend, value.model);

  const handleBackendChange = (next: AgentBackendId) => {
    if (next === value.backend) return;
    if (next === "codex") {
      onChange({
        backend: "codex",
        model: "gpt-5.4",
        reasoningEffort: "medium",
      });
    } else {
      onChange({
        backend: "claude",
        model: "opus",
        reasoningEffort: "medium",
      });
    }
  };

  return (
    <>
      <ConfigField
        label="Backend"
        fieldPath="workflowDefaults.implementer.backend"
        isDefault={false}
        isModified={false}
      >
        <ConfigPillGroup
          value={backend}
          options={["claude", "codex"] as const}
          onChange={handleBackendChange}
        />
      </ConfigField>

      <ConfigField
        label="Model"
        fieldPath="workflowDefaults.implementer.model"
        isDefault={false}
        isModified={false}
      >
        <ModelSelector
          value={value.model}
          backend={backend}
          onChange={(model) => {
            if (backend === "codex") {
              onChange({
                backend: "codex",
                model: model as GraphWorkflowAgentConfig["model"],
                reasoningEffort: value.reasoningEffort,
              } as GraphWorkflowAgentConfig);
            } else {
              onChange({
                backend: "claude",
                model: model as "opus" | "sonnet" | "haiku",
                reasoningEffort: value.reasoningEffort as EffortLevel,
              });
            }
          }}
        />
      </ConfigField>

      <ConfigField
        label="Reasoning effort"
        fieldPath="workflowDefaults.implementer.reasoningEffort"
        isDefault={false}
        isModified={false}
      >
        <ReasoningLevelSelector
          value={value.reasoningEffort as EffortLevel}
          availableLevels={effortOptions}
          onChange={(level) =>
            onChange({
              ...value,
              reasoningEffort: level,
            } as GraphWorkflowAgentConfig)
          }
        />
      </ConfigField>
    </>
  );
}
