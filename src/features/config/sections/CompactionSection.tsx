import { useMemo } from "react";
import { getDefaultCodexModel } from "@/lib/agent-backends/schemas";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { ConfigField } from "../components/ConfigField";
import { ConfigNumericInput } from "../components/ConfigNumericInput";
import { ConfigPillGroup } from "../components/ConfigPillGroup";
import { SettingsPage } from "../components/SettingsPage";
import { SettingsSubSection } from "../components/SettingsSubSection";
import {
  getEffortOptionsForBackend,
  getModelOptionsForBackend,
} from "../config-helpers";
import type { ConfigFormController } from "./types";

// Schema defaults (compactionConfigSchema): claude backend, sonnet models,
// medium effort. Mirrored here so the section renders the effective defaults
// when config.json carries no `compaction` block yet.
const CLAUDE_DEFAULT_MODEL = "sonnet";
const DEFAULT_EFFORT = "medium";

function defaultModelForBackend(backend: AgentBackendId): string {
  return backend === "codex" ? getDefaultCodexModel() : CLAUDE_DEFAULT_MODEL;
}

export function CompactionSection({
  controller,
}: {
  controller: ConfigFormController;
}): React.JSX.Element {
  const { formState, handleChange, handleChangeMulti, isDefault, isModified } =
    controller;

  const compaction = formState.compaction;
  const backend: AgentBackendId = compaction?.backend ?? "claude";
  const conversationModel =
    compaction?.conversationModel ?? CLAUDE_DEFAULT_MODEL;
  const messageModel = compaction?.messageModel ?? CLAUDE_DEFAULT_MODEL;
  const effort = compaction?.effort ?? DEFAULT_EFFORT;

  const modelOptions = getModelOptionsForBackend(backend);
  // A single effort applies to both models; scope its options to the primary
  // (conversation) model, matching the DefaultsSection convention. The backend
  // clamps per-model, so an effort the message model doesn't support is safe.
  const effortOptions = useMemo(
    () => getEffortOptionsForBackend(backend, conversationModel),
    [backend, conversationModel],
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
            options={["claude", "codex"] as const}
            onChange={(value) => {
              // conversationModel/messageModel are a single shared field per
              // kind, not split by backend, so a backend switch must reset them
              // to a model valid for the new backend. Effort clears to its
              // schema default (medium), which every backend supports.
              handleChangeMulti([
                ["compaction.backend", value],
                ["compaction.conversationModel", defaultModelForBackend(value)],
                ["compaction.messageModel", defaultModelForBackend(value)],
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
          />
        </ConfigField>
      </SettingsSubSection>
    </SettingsPage>
  );
}
