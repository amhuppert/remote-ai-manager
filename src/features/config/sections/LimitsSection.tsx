import { ConfigField } from "../components/ConfigField";
import { ConfigNumericInput } from "../components/ConfigNumericInput";
import { SettingsPage } from "../components/SettingsPage";
import type { ConfigFormController } from "./types";

export function LimitsSection({
  controller,
}: {
  controller: ConfigFormController;
}): React.JSX.Element {
  const {
    formState,
    formRevision,
    handleChange,
    handleValidityChange,
    isDefault,
    isModified,
  } = controller;
  return (
    <SettingsPage
      title="Limits &"
      accent="timeouts"
      sub="Bounds for runaway agents, idle sessions and pre-merge automation."
    >
      <div className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-md rounded-lg border border-solid border-border-subtle bg-bg-surface px-[14px] pt-md pb-[14px] max-768:grid-cols-[1fr]">
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
            name="maxTurns"
            aria-label="Max turns"
            onValidityChange={(valid) =>
              handleValidityChange("maxTurns", valid)
            }
            resetKey={formRevision}
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
            name="maxConcurrentQueries"
            aria-label="Max concurrent queries"
            onValidityChange={(valid) =>
              handleValidityChange("maxConcurrentQueries", valid)
            }
            resetKey={formRevision}
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
            name="preMergeTimeoutMs"
            aria-label="Pre-merge timeout"
            aria-describedby="preMergeTimeoutMs-hint"
            onValidityChange={(valid) =>
              handleValidityChange("preMergeTimeoutMs", valid)
            }
            resetKey={formRevision}
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
            name="idleQuerySessionTtlMs"
            aria-label="Idle session TTL"
            aria-describedby="idleQuerySessionTtlMs-hint"
            onValidityChange={(valid) =>
              handleValidityChange("idleQuerySessionTtlMs", valid)
            }
            resetKey={formRevision}
            displayAsMinutes
            positive
          />
        </ConfigField>
      </div>
    </SettingsPage>
  );
}
