import { useMemo } from "react";
import {
  effortLevelsForCatalogEntry,
  type BackendCatalogEntry,
} from "@/lib/agent-backends/catalog";
import { useBackendCatalogQuery } from "@/lib/agent-backends/queries";
import { compactionConfigSchema } from "@/lib/config/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { ConfigField } from "../components/ConfigField";
import { ConfigNumericInput } from "../components/ConfigNumericInput";
import { ConfigPillGroup } from "../components/ConfigPillGroup";
import { SettingsPage } from "../components/SettingsPage";
import { SettingsSubSection } from "../components/SettingsSubSection";
import type { ConfigFormController } from "./types";

// Effective defaults rendered when config.json carries no `compaction` block
// yet. For the schema's own default backend, the compaction default model is
// deliberately the schema's — a per-feature summarizer choice, not the backend
// catalog default. Any other backend starts from its catalog default model.
const COMPACTION_DEFAULTS = compactionConfigSchema.parse({});

function defaultModelForBackend(entry: BackendCatalogEntry): string {
  return entry.id === COMPACTION_DEFAULTS.backend
    ? COMPACTION_DEFAULTS.conversationModel
    : entry.defaultModelId;
}

export function CompactionSection({
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

  const compaction = formState.compaction;
  const backend: AgentBackendId =
    compaction?.backend ?? COMPACTION_DEFAULTS.backend;
  const conversationModel =
    compaction?.conversationModel ?? COMPACTION_DEFAULTS.conversationModel;
  const messageModel =
    compaction?.messageModel ?? COMPACTION_DEFAULTS.messageModel;
  const effort = compaction?.effort ?? COMPACTION_DEFAULTS.effort;

  const { data: backends } = useBackendCatalogQuery();
  const entry = backends.find((b) => b.id === backend);
  if (!entry) {
    throw new Error(`Unknown agent backend: ${backend}`);
  }

  const modelOptions = entry.models.map((m) => m.id);
  // A single effort applies to both models, so its options follow the primary
  // conversation model. The backend clamps per-model, so an effort the message
  // model doesn't support is safe.
  const effortOptions = useMemo(
    () => effortLevelsForCatalogEntry(entry, conversationModel),
    [entry, conversationModel],
  );

  return (
    <SettingsPage
      title="Conversation"
      accent="compaction"
      sub="The backend, model and reasoning effort used to summarize conversations and oversized messages into compaction artifacts."
    >
      <SettingsSubSection
        title="Compaction backend"
        hint="Determines which model and effort options apply below."
      >
        <ConfigField
          label="Backend"
          fieldPath="compaction.backend"
          isDefault={isDefault("compaction.backend")}
          isModified={isModified("compaction.backend")}
        >
          <ConfigPillGroup
            value={backend}
            options={backends.map((b) => b.id)}
            onChange={(value) => {
              const nextEntry = backends.find((b) => b.id === value);
              if (!nextEntry) {
                throw new Error(`Unknown agent backend: ${value}`);
              }
              const nextModel = defaultModelForBackend(nextEntry);
              // conversationModel/messageModel are a single shared field per
              // kind, not split by backend, so a backend switch must reset them
              // to a model valid for the new backend. Effort clears to its
              // schema default (medium), which every backend supports.
              handleChangeMulti([
                ["compaction.backend", value],
                ["compaction.conversationModel", nextModel],
                ["compaction.messageModel", nextModel],
                ["compaction.effort", undefined],
              ]);
            }}
          />
        </ConfigField>
      </SettingsSubSection>
      <SettingsSubSection
        title="Models & reasoning"
        hint="Conversation model summarizes a whole conversation; message model condenses a single oversized message."
      >
        <ConfigField
          label="Conversation model"
          fieldPath="compaction.conversationModel"
          isDefault={isDefault("compaction.conversationModel")}
          isModified={isModified("compaction.conversationModel")}
        >
          <ConfigPillGroup
            value={conversationModel}
            options={modelOptions}
            onChange={(value) =>
              handleChange("compaction.conversationModel", value)
            }
          />
        </ConfigField>
        <ConfigField
          label="Message model"
          fieldPath="compaction.messageModel"
          isDefault={isDefault("compaction.messageModel")}
          isModified={isModified("compaction.messageModel")}
        >
          <ConfigPillGroup
            value={messageModel}
            options={modelOptions}
            onChange={(value) => handleChange("compaction.messageModel", value)}
          />
        </ConfigField>
        {effortOptions.length > 0 ? (
          <ConfigField
            label="Effort"
            fieldPath="compaction.effort"
            isDefault={isDefault("compaction.effort")}
            isModified={isModified("compaction.effort")}
            hint="Applies to both compaction models."
          >
            <ConfigPillGroup
              value={effort}
              options={effortOptions}
              onChange={(value) => handleChange("compaction.effort", value)}
            />
          </ConfigField>
        ) : null}
        <ConfigField
          label="Timeout"
          fieldPath="compaction.timeoutMs"
          isDefault={isDefault("compaction.timeoutMs")}
          isModified={isModified("compaction.timeoutMs")}
          hint="Minutes. Empty means no timeout."
        >
          <ConfigNumericInput
            value={compaction?.timeoutMs}
            onChange={(value) =>
              handleChange("compaction.timeoutMs", value ?? null)
            }
            displayAsMinutes
            positive
            name="compaction.timeoutMs"
            aria-label="Compaction timeout"
            aria-describedby="compaction.timeoutMs-hint"
            onValidityChange={(valid) =>
              handleValidityChange("compaction.timeoutMs", valid)
            }
            resetKey={formRevision}
          />
        </ConfigField>
      </SettingsSubSection>
    </SettingsPage>
  );
}
