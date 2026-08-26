import { DesktopModelSelectionControls } from "@/components/session/prompt/ModelSelectionControls";
import { getConfiguredBackendModelCatalog } from "@/lib/agent-backends/catalog";
import { backendFacetRefusalIn } from "@/lib/agent-backends/facet-gating";
import { defaultSelectionForModel } from "@/lib/agent-backends/model-selection";
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
  const catalog = getConfiguredBackendModelCatalog(
    value.backend,
    value.modelSelection,
  );

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
        modelSelection: defaultSelectionForModel(
          getConfiguredBackendModelCatalog(next),
          nextEntry.defaultModelId,
        ),
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
        label="Model selection"
        fieldPath={`${fieldPathPrefix}.modelSelection`}
        isDefault={false}
        isModified={false}
      >
        <DesktopModelSelectionControls
          catalog={catalog}
          selection={value.modelSelection}
          onSelectionChange={(modelSelection) => {
            onChange(
              graphWorkflowAgentConfigSchema.parse({
                backend,
                modelSelection,
              }),
            );
          }}
        />
      </ConfigField>
    </>
  );
}
