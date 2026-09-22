import { redactAgentCapabilityText } from "@/lib/agent-backends/capability-redaction";
export { redactAgentCapabilityText } from "@/lib/agent-backends/capability-redaction";
import type {
  AgentCapabilityDiagnostic,
  AgentCapabilityInventory,
  AgentCapabilityViewResponse,
  AgentCapabilityViewRow,
} from "./schemas";

function redactAgentCapabilityDiagnostic(
  diagnostic: AgentCapabilityDiagnostic,
): AgentCapabilityDiagnostic {
  return {
    ...diagnostic,
    message: redactAgentCapabilityText(diagnostic.message),
  };
}

export function redactAgentCapabilityViewResponse(
  view: AgentCapabilityViewResponse,
): AgentCapabilityViewResponse {
  return {
    ...view,
    diagnostics: view.diagnostics.map(redactAgentCapabilityDiagnostic),
    items: view.items.map(redactAgentCapabilityViewRow),
  };
}

export function redactAgentCapabilityInventory(
  inventory: AgentCapabilityInventory,
): AgentCapabilityInventory {
  return {
    ...inventory,
    diagnostics: inventory.diagnostics.map(redactAgentCapabilityDiagnostic),
  };
}

function redactAgentCapabilityViewRow(
  row: AgentCapabilityViewRow,
): AgentCapabilityViewRow {
  return {
    ...row,
    diagnostics: row.diagnostics.map(redactAgentCapabilityDiagnostic),
  };
}
