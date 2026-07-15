import type { GraphWorkflowAskUserQuestionsConfig } from "@/lib/workflow-graph/config-schemas";
import { ConfigField } from "../../components/ConfigField";
import { ConfigToggle } from "../../components/ConfigToggle";

export function AskUserQuestionsFields({
  value,
  onChange,
}: {
  value: GraphWorkflowAskUserQuestionsConfig;
  onChange: (v: GraphWorkflowAskUserQuestionsConfig) => void;
}) {
  return (
    <ConfigField
      label="Enabled"
      fieldPath="workflowDefaults.askUserQuestions.enabled"
      isDefault={false}
      isModified={false}
      hint="Let graph-workflow implementer and validator agents ask you questions mid-task. Off keeps them fully autonomous."
    >
      <ConfigToggle
        label="Ask user questions enabled"
        value={value.enabled}
        onChange={(enabled) => onChange({ enabled })}
      />
    </ConfigField>
  );
}
