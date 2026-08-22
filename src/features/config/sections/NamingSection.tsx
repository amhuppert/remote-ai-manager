import { useMemo } from "react";
import {
  effortLevelsForCatalogEntry,
  type BackendCatalogEntry,
} from "@/lib/agent-backends/catalog";
import { backendFacetRefusalIn } from "@/lib/agent-backends/facet-gating";
import { useBackendCatalogQuery } from "@/lib/agent-backends/queries";
import { conversationNamingConfigSchema } from "@/lib/config/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { ConfigField } from "../components/ConfigField";
import { ConfigNumericInput } from "../components/ConfigNumericInput";
import { ConfigPillGroup } from "../components/ConfigPillGroup";
import { ConfigToggle } from "../components/ConfigToggle";
import { SettingsPage } from "../components/SettingsPage";
import { SettingsSubSection } from "../components/SettingsSubSection";
import type { ConfigFormController } from "./types";

// Effective defaults rendered when config.json carries no `conversationNaming`
// block yet. For the schema's own default backend, the naming default model is
// deliberately the schema's (haiku — a cheap one-shot titler), not the backend
// catalog default. Any other backend starts from its catalog default model.
const NAMING_DEFAULTS = conversationNamingConfigSchema.parse({});

function defaultModelForBackend(entry: BackendCatalogEntry): string {
  return entry.id === NAMING_DEFAULTS.backend
    ? NAMING_DEFAULTS.model
    : entry.defaultModelId;
}

export function NamingSection({
  controller,
}: {
  controller: ConfigFormController;
}): React.JSX.Element {
  const {
    formState,
    formRevision,
    handleChange,
    handleChangeMulti,
    handleValidityChange,
    isDefault,
    isModified,
  } = controller;

  const naming = formState.conversationNaming;
  const enabled = naming?.enabled ?? NAMING_DEFAULTS.enabled;
  const backend: AgentBackendId = naming?.backend ?? NAMING_DEFAULTS.backend;
  const model = naming?.model ?? NAMING_DEFAULTS.model;
  const effort = naming?.effort ?? NAMING_DEFAULTS.effort;

  const { data: backends } = useBackendCatalogQuery();
  const entry = backends.find((b) => b.id === backend);
  if (!entry) {
    throw new Error(`Unknown agent backend: ${backend}`);
  }

  const modelOptions = entry.models.map((m) => m.id);
  const modelLabel = (value: string) =>
    entry.models.find((option) => option.id === value)?.label ?? value;
  const effortOptions = useMemo(
    () => effortLevelsForCatalogEntry(entry, model),
    [entry, model],
  );

  return (
    <SettingsPage
      title="Conversation"
      accent="naming"
      sub="Names new conversations in the background from their first user message. The toggle gates only automatic naming; the explicit regenerate actions always work."
    >
      <SettingsSubSection
        title="Automatic naming"
        hint="When off, new conversations keep their numbered placeholder names."
      >
        <ConfigField
          label="Automatic naming enabled"
          fieldPath="conversationNaming.enabled"
          isDefault={isDefault("conversationNaming.enabled")}
          isModified={isModified("conversationNaming.enabled")}
        >
          <ConfigToggle
            label="Automatic naming enabled"
            value={enabled}
            onChange={(value) =>
              handleChange("conversationNaming.enabled", value)
            }
          />
        </ConfigField>
      </SettingsSubSection>
      <SettingsSubSection
        title="Model & reasoning"
        hint="The backend, model and effort used for the one-shot naming call."
      >
        <ConfigField
          label="Backend"
          fieldPath="conversationNaming.backend"
          isDefault={isDefault("conversationNaming.backend")}
          isModified={isModified("conversationNaming.backend")}
        >
          <ConfigPillGroup
            value={backend}
            options={backends.map((b) => b.id)}
            // Naming runs as a one-shot task, so a backend with no task facet
            // cannot be selected here (spec D13).
            getOptionDisabledReason={(id) =>
              backendFacetRefusalIn(backends, id, "tasks")
            }
            onChange={(value) => {
              const nextEntry = backends.find((b) => b.id === value);
              if (!nextEntry) {
                throw new Error(`Unknown agent backend: ${value}`);
              }
              // The model field is shared across backends, so a backend switch
              // must reset it to a model valid for the new backend. Effort
              // clears so the schema default applies (clamped per-model by the
              // naming service).
              handleChangeMulti([
                ["conversationNaming.backend", value],
                ["conversationNaming.model", defaultModelForBackend(nextEntry)],
                ["conversationNaming.effort", undefined],
              ]);
            }}
          />
        </ConfigField>
        <ConfigField
          label="Model"
          fieldPath="conversationNaming.model"
          isDefault={isDefault("conversationNaming.model")}
          isModified={isModified("conversationNaming.model")}
        >
          <ConfigPillGroup
            value={model}
            options={modelOptions}
            getOptionLabel={modelLabel}
            onChange={(value) =>
              handleChange("conversationNaming.model", value)
            }
          />
        </ConfigField>
        {effortOptions.length > 0 ? (
          <ConfigField
            label="Effort"
            fieldPath="conversationNaming.effort"
            isDefault={isDefault("conversationNaming.effort")}
            isModified={isModified("conversationNaming.effort")}
          >
            <ConfigPillGroup
              value={effort}
              options={effortOptions}
              onChange={(value) =>
                handleChange("conversationNaming.effort", value)
              }
            />
          </ConfigField>
        ) : null}
        <ConfigField
          label="Timeout"
          fieldPath="conversationNaming.timeoutMs"
          isDefault={isDefault("conversationNaming.timeoutMs")}
          isModified={isModified("conversationNaming.timeoutMs")}
          hint="Minutes. Empty = 1 minute default."
        >
          <ConfigNumericInput
            value={naming?.timeoutMs}
            onChange={(value) =>
              handleChange("conversationNaming.timeoutMs", value ?? null)
            }
            displayAsMinutes
            positive
            name="conversationNaming.timeoutMs"
            aria-label="Naming timeout"
            aria-describedby="conversationNaming.timeoutMs-hint"
            onValidityChange={(valid) =>
              handleValidityChange("conversationNaming.timeoutMs", valid)
            }
            resetKey={formRevision}
          />
        </ConfigField>
      </SettingsSubSection>
    </SettingsPage>
  );
}
