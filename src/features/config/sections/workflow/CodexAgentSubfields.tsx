import ModelSelector from "@/components/ModelSelector";
import ReasoningLevelSelector from "@/components/ReasoningLevelSelector";
import type {
  CodexModel,
  CodexReasoningEffort,
  EffortLevel,
} from "@/lib/agent-backends/schemas";
import { ConfigField } from "../../components/ConfigField";
import { getEffortOptionsForBackend } from "../../config-helpers";

export function CodexAgentSubfields({
  model,
  reasoningEffort,
  onCodexChange,
}: {
  model: CodexModel | undefined;
  reasoningEffort: CodexReasoningEffort | undefined;
  onCodexChange: (codex: {
    model?: CodexModel;
    reasoningEffort?: CodexReasoningEffort;
  }) => void;
}) {
  const effectiveModel = (model ?? "gpt-5.4") as CodexModel;
  const effectiveEffort = (reasoningEffort ?? "medium") as CodexReasoningEffort;
  const effortOptions = getEffortOptionsForBackend("codex", effectiveModel);

  return (
    <>
      <ConfigField
        label="Codex model"
        fieldPath="workflowDefaults.contextValidator.assignments.0.agent.model"
        isDefault={false}
        isModified={false}
      >
        <ModelSelector
          value={effectiveModel}
          backend="codex"
          onChange={(next) =>
            onCodexChange({
              model: next as CodexModel,
              reasoningEffort: effectiveEffort,
            })
          }
        />
      </ConfigField>
      <ConfigField
        label="Codex effort"
        fieldPath="workflowDefaults.contextValidator.assignments.0.agent.reasoningEffort"
        isDefault={false}
        isModified={false}
      >
        <ReasoningLevelSelector
          value={effectiveEffort as EffortLevel}
          availableLevels={effortOptions}
          onChange={(level) =>
            onCodexChange({
              model: effectiveModel,
              reasoningEffort: level as CodexReasoningEffort,
            })
          }
        />
      </ConfigField>
    </>
  );
}
