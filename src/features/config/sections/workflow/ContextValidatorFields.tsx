import type { GraphWorkflowAgentValidatorConfig } from "@/lib/workflow-graph/config-schemas";
import { agentBackendSchema } from "@/lib/shared/schemas";
import { ConfigField } from "../../components/ConfigField";
import { ConfigNumericInput } from "../../components/ConfigNumericInput";
import { ConfigPillGroup } from "../../components/ConfigPillGroup";
import { ConfigToggle } from "../../components/ConfigToggle";
import { ClaudeAgentSubfields } from "./ClaudeAgentSubfields";
import { CodexAgentSubfields } from "./CodexAgentSubfields";

export function ContextValidatorFields({
  value,
  onChange,
}: {
  value: GraphWorkflowAgentValidatorConfig;
  onChange: (v: GraphWorkflowAgentValidatorConfig) => void;
}) {
  const type = value.type;
  const continuityEnabled = value.continuity?.enabled ?? true;
  const continuityLimit = value.continuity?.contextLimitTokens;

  const handleTypeChange = (next: "claude" | "codex") => {
    if (next === value.type) return;
    if (next === "codex") {
      onChange({
        type: "codex",
        enabled: value.enabled,
        continuity: value.continuity ?? { enabled: true },
        codex: { model: "gpt-5.4", reasoningEffort: "medium" },
      });
    } else {
      onChange({
        type: "claude",
        enabled: value.enabled,
        continuity: value.continuity ?? { enabled: true },
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      });
    }
  };

  return (
    <>
      <ConfigField
        label="Type"
        fieldPath="workflowDefaults.contextValidator.type"
        isDefault={false}
        isModified={false}
      >
        <ConfigPillGroup
          value={type}
          options={agentBackendSchema.options}
          onChange={handleTypeChange}
        />
      </ConfigField>

      <ConfigField
        label="Enabled"
        fieldPath="workflowDefaults.contextValidator.enabled"
        isDefault={false}
        isModified={false}
      >
        <ConfigToggle
          label="Context validator enabled"
          value={value.enabled}
          onChange={(v) => onChange({ ...value, enabled: v })}
        />
      </ConfigField>

      {value.type === "claude" && value.agent.backend === "claude" && (
        <ClaudeAgentSubfields
          agent={value.agent}
          onAgentChange={(agent) =>
            onChange({
              type: "claude",
              enabled: value.enabled,
              continuity: value.continuity,
              agent,
            })
          }
        />
      )}

      {value.type === "codex" && (
        <CodexAgentSubfields
          model={value.codex.model}
          reasoningEffort={value.codex.reasoningEffort}
          onCodexChange={(codex) =>
            onChange({
              type: "codex",
              enabled: value.enabled,
              continuity: value.continuity,
              codex,
            })
          }
        />
      )}

      <ConfigField
        label="Continuity"
        fieldPath="workflowDefaults.contextValidator.continuity.enabled"
        isDefault={false}
        isModified={false}
      >
        <ConfigToggle
          label="Context validator continuity"
          value={continuityEnabled}
          onChange={(v) =>
            onChange({
              ...value,
              continuity: {
                enabled: v,
                ...(continuityLimit !== undefined
                  ? { contextLimitTokens: continuityLimit }
                  : {}),
              },
            })
          }
        />
      </ConfigField>

      <ConfigField
        label="Context limit tokens"
        fieldPath="workflowDefaults.contextValidator.continuity.contextLimitTokens"
        isDefault={false}
        isModified={false}
        hint="Leave empty for auto"
      >
        <ConfigNumericInput
          value={continuityLimit}
          onChange={(v) =>
            onChange({
              ...value,
              continuity: {
                enabled: continuityEnabled,
                ...(v !== undefined && v !== null
                  ? { contextLimitTokens: v }
                  : {}),
              },
            })
          }
          positive
          integer
        />
      </ConfigField>
    </>
  );
}
