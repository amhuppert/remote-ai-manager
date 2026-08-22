import ModelSelector from "@/components/ModelSelector";
import ReasoningLevelSelector from "@/components/ReasoningLevelSelector";
import { effortLevelsForCatalogEntry } from "@/lib/agent-backends/catalog";
import { backendFacetRefusalIn } from "@/lib/agent-backends/facet-gating";
import { useBackendCatalogQuery } from "@/lib/agent-backends/queries";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  graphWorkflowAgentConfigSchema,
  type GraphWorkflowAgentConfig,
} from "@/lib/workflow-graph/config-schemas";
import { ConfigField } from "../../components/ConfigField";
import { ConfigPillGroup } from "../../components/ConfigPillGroup";

export function AgentConfigFields({
  value,
  onChange,
  fieldPathPrefix,
}: {
  value: GraphWorkflowAgentConfig;
  onChange: (v: GraphWorkflowAgentConfig) => void;
  fieldPathPrefix: string;
}) {
  const backend = value.backend;
  const { data: backends } = useBackendCatalogQuery();
  const entry = backends.find((b) => b.id === backend);
  if (!entry) {
    throw new Error(`Unknown agent backend: ${backend}`);
  }
  const effortOptions = effortLevelsForCatalogEntry(entry, value.model);

  const handleBackendChange = (next: AgentBackendId) => {
    if (next === value.backend) return;
    const nextEntry = backends.find((b) => b.id === next);
    if (!nextEntry) {
      throw new Error(`Unknown agent backend: ${next}`);
    }
    // The agent config is a per-backend discriminated union; parsing through
    // the schema keeps the construction typed without per-backend literals.
    onChange(
      graphWorkflowAgentConfigSchema.parse({
        backend: next,
        model: nextEntry.defaultModelId,
        reasoningEffort: "medium",
      }),
    );
  };

  return (
    <>
      <ConfigField
        label="Backend"
        fieldPath={`${fieldPathPrefix}.backend`}
        isDefault={false}
        isModified={false}
      >
        <ConfigPillGroup
          value={backend}
          options={backends.map((b) => b.id)}
          // A workflow role is dispatched through the backend's task facet, so
          // a backend registering none cannot hold one (spec D13).
          getOptionDisabledReason={(id) =>
            backendFacetRefusalIn(backends, id, "tasks")
          }
          onChange={handleBackendChange}
        />
      </ConfigField>

      <ConfigField
        label="Model"
        fieldPath={`${fieldPathPrefix}.model`}
        isDefault={false}
        isModified={false}
      >
        <ModelSelector
          value={value.model}
          backend={backend}
          onChange={(model) => {
            onChange(
              graphWorkflowAgentConfigSchema.parse({
                backend,
                model,
                reasoningEffort: value.reasoningEffort,
              }),
            );
          }}
        />
      </ConfigField>

      <ConfigField
        label="Reasoning effort"
        fieldPath={`${fieldPathPrefix}.reasoningEffort`}
        isDefault={false}
        isModified={false}
      >
        <ReasoningLevelSelector
          value={value.reasoningEffort}
          availableLevels={effortOptions}
          onChange={(level) =>
            onChange(
              graphWorkflowAgentConfigSchema.parse({
                backend,
                model: value.model,
                reasoningEffort: level,
              }),
            )
          }
        />
      </ConfigField>
    </>
  );
}
