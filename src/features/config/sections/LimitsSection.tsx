import { ConfigField } from "../components/ConfigField";
import { ConfigNumericInput } from "../components/ConfigNumericInput";
import { SettingsPage } from "../components/SettingsPage";
import type { ConfigFormController } from "./types";

export function LimitsSection({
  controller,
}: {
  controller: ConfigFormController;
}): React.JSX.Element {
  const { formState, handleChange, isDefault, isModified } = controller;
  return (
    <SettingsPage
      title="Limits &"
      accent="timeouts"
      sub="Bounds for runaway agents, idle sessions and pre-merge automation."
    >
      <div className="config-field-row config-field-row--grid">
        <ConfigField
          label="Claude timeout"
          fieldPath="claudeTimeoutMs"
          isDefault={isDefault("claudeTimeoutMs")}
          isModified={isModified("claudeTimeoutMs")}
          hint="minutes"
        >
          <ConfigNumericInput
            value={formState.claudeTimeoutMs}
            onChange={(value) =>
              handleChange("claudeTimeoutMs", value ?? 3_600_000)
            }
            displayAsMinutes
            required
            positive
          />
        </ConfigField>
        <ConfigField
          label="Max turns"
          fieldPath="maxTurns"
          isDefault={isDefault("maxTurns")}
          isModified={isModified("maxTurns")}
          hint="Hard cap per conversation. Empty means unbounded."
        >
          <ConfigNumericInput
            value={formState.maxTurns}
            onChange={(value) => handleChange("maxTurns", value)}
            positive
            integer
          />
        </ConfigField>
        <ConfigField
          label="Max concurrent queries"
          fieldPath="maxConcurrentQueries"
          isDefault={isDefault("maxConcurrentQueries")}
          isModified={isModified("maxConcurrentQueries")}
        >
          <ConfigNumericInput
            value={formState.maxConcurrentQueries}
            onChange={(value) => handleChange("maxConcurrentQueries", value)}
            positive
            integer
          />
        </ConfigField>
        <ConfigField
          label="Pre-merge timeout"
          fieldPath="preMergeTimeoutMs"
          isDefault={isDefault("preMergeTimeoutMs")}
          isModified={isModified("preMergeTimeoutMs")}
          hint="minutes"
        >
          <ConfigNumericInput
            value={formState.preMergeTimeoutMs}
            onChange={(value) => handleChange("preMergeTimeoutMs", value)}
            displayAsMinutes
            positive
          />
        </ConfigField>
        <ConfigField
          label="Idle session TTL"
          fieldPath="idleQuerySessionTtlMs"
          isDefault={isDefault("idleQuerySessionTtlMs")}
          isModified={isModified("idleQuerySessionTtlMs")}
          hint="minutes"
        >
          <ConfigNumericInput
            value={formState.idleQuerySessionTtlMs}
            onChange={(value) => handleChange("idleQuerySessionTtlMs", value)}
            displayAsMinutes
            positive
          />
        </ConfigField>
      </div>
    </SettingsPage>
  );
}
