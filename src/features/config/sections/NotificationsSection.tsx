import { FormInput } from "@/components/ui/FormField";
import { ConfigField } from "../components/ConfigField";
import { ConfigPillGroup } from "../components/ConfigPillGroup";
import { ConfigToggle } from "../components/ConfigToggle";
import { SettingsPage } from "../components/SettingsPage";
import { SettingsSubSection } from "../components/SettingsSubSection";
import { formatFieldLabel } from "../config-helpers";
import type { ConfigFormController } from "./types";

const PUSH_TRIGGERS = [
  "jobCompleted",
  "waitingForInput",
  "workflowCompleted",
  "workflowHalted",
  "conversationIdle",
] as const;

export function NotificationsSection({
  controller,
}: {
  controller: ConfigFormController;
}): React.JSX.Element {
  const { formState, handleChange, isDefault, isModified } = controller;
  return (
    <SettingsPage
      title="Push"
      accent="notifications"
      sub="Get pinged when conversations finish, halt, or wait on you."
    >
      <SettingsSubSection title="Provider">
        <ConfigField
          label="Push notifications enabled"
          fieldPath="pushNotification.enabled"
          isDefault={isDefault("pushNotification.enabled")}
          isModified={isModified("pushNotification.enabled")}
        >
          <ConfigToggle
            label="Push notifications enabled"
            value={formState.pushNotification?.enabled ?? false}
            onChange={(value) =>
              handleChange("pushNotification.enabled", value)
            }
          />
        </ConfigField>
        <ConfigField
          label="Provider"
          fieldPath="pushNotification.provider"
          isDefault={isDefault("pushNotification.provider")}
          isModified={isModified("pushNotification.provider")}
        >
          <ConfigPillGroup
            value={formState.pushNotification?.provider ?? "ntfy"}
            options={["ntfy", "pushover"] as const}
            onChange={(value) =>
              handleChange("pushNotification.provider", value)
            }
          />
        </ConfigField>
        <ConfigField
          label="Server URL"
          fieldPath="pushNotification.serverUrl"
          isDefault={isDefault("pushNotification.serverUrl")}
          isModified={isModified("pushNotification.serverUrl")}
        >
          <FormInput
            type="text"
            value={formState.pushNotification?.serverUrl ?? ""}
            onChange={(e) =>
              handleChange("pushNotification.serverUrl", e.target.value)
            }
            placeholder="https://ntfy.sh"
          />
        </ConfigField>
        <ConfigField
          label="Topic"
          fieldPath="pushNotification.topic"
          isDefault={isDefault("pushNotification.topic")}
          isModified={isModified("pushNotification.topic")}
          hint="A long random string keeps your notification stream private."
        >
          <FormInput
            type="text"
            value={formState.pushNotification?.topic ?? ""}
            onChange={(e) =>
              handleChange("pushNotification.topic", e.target.value)
            }
          />
        </ConfigField>
      </SettingsSubSection>
      <SettingsSubSection
        title="Triggers"
        hint="Each event maps to a notification. Disable individually."
      >
        {PUSH_TRIGGERS.map((trigger) => (
          <ConfigField
            key={trigger}
            label={formatFieldLabel(trigger)}
            fieldPath={`pushNotification.triggers.${trigger}`}
            isDefault={isDefault(`pushNotification.triggers.${trigger}`)}
            isModified={isModified(`pushNotification.triggers.${trigger}`)}
          >
            <ConfigToggle
              label={`Notify on ${formatFieldLabel(trigger)}`}
              value={formState.pushNotification?.triggers?.[trigger] ?? true}
              onChange={(value) =>
                handleChange(`pushNotification.triggers.${trigger}`, value)
              }
            />
          </ConfigField>
        ))}
      </SettingsSubSection>
    </SettingsPage>
  );
}
