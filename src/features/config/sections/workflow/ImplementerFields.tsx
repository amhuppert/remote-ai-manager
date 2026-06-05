import type { GraphWorkflowAgentConfig } from "@/lib/workflows/schemas";
import { AgentConfigFields } from "./AgentConfigFields";

export function ImplementerFields({
  value,
  onChange,
}: {
  value: GraphWorkflowAgentConfig;
  onChange: (v: GraphWorkflowAgentConfig) => void;
}) {
  return (
    <AgentConfigFields
      value={value}
      onChange={onChange}
      fieldPathPrefix="workflowDefaults.implementer"
    />
  );
}
