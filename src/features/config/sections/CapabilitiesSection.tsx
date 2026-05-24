import { useMemo } from "react";
import { AgentCapabilitiesConfigurator } from "@/components/agent-capabilities/AgentCapabilitiesConfigurator";
import type { AgentCapabilityLayerOption } from "@/components/agent-capabilities/AgentCapabilityPanel";

export function CapabilitiesSection(): React.JSX.Element {
  const layerOptions = useMemo<readonly AgentCapabilityLayerOption[]>(
    () => [{ label: "Global", scope: { level: "global" } }],
    [],
  );
  return (
    <AgentCapabilitiesConfigurator
      layerOptions={layerOptions}
      initialScope={{ level: "global" }}
    />
  );
}
