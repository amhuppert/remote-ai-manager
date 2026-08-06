import ModelSelector from "@/components/ModelSelector";
import ReasoningLevelSelector from "@/components/ReasoningLevelSelector";
import type { ClaudeModel, EffortLevel } from "@/lib/agent-backends/schemas";
import { ConfigField } from "../../components/ConfigField";
import { getEffortOptionsForBackend } from "../../config-helpers";

export interface ClaudeAgentValue {
  backend: "claude";
  model: ClaudeModel;
  reasoningEffort: EffortLevel;
}

export function ClaudeAgentSubfields({
  agent,
  onAgentChange,
}: {
  agent: ClaudeAgentValue;
  onAgentChange: (agent: ClaudeAgentValue) => void;
}) {
  return (
    <>
      <ConfigField
        label="Agent model"
        fieldPath="workflowDefaults.contextValidator.assignments.0.agent.model"
        isDefault={false}
        isModified={false}
      >
        <ModelSelector
          value={agent.model}
          backend="claude"
          onChange={(model) =>
            onAgentChange({
              backend: "claude",
              model: model as ClaudeModel,
              reasoningEffort: agent.reasoningEffort,
            })
          }
        />
      </ConfigField>
      <ConfigField
        label="Agent effort"
        fieldPath="workflowDefaults.contextValidator.assignments.0.agent.reasoningEffort"
        isDefault={false}
        isModified={false}
      >
        <ReasoningLevelSelector
          value={agent.reasoningEffort}
          availableLevels={getEffortOptionsForBackend("claude", agent.model)}
          onChange={(level) =>
            onAgentChange({
              backend: "claude",
              model: agent.model,
              reasoningEffort: level,
            })
          }
        />
      </ConfigField>
    </>
  );
}
