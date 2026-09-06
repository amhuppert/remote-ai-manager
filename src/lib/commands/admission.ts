import { getBackendDescriptor } from "@/lib/agent-backends/registry";
import { catalogEntryFromDescriptor } from "@/lib/agent-backends/catalog";
import { BackendAdmissionError } from "@/lib/agent-backends/execution-admission";
import type { AgentBackendId } from "@/lib/shared/schemas";
import { createLogger } from "@/lib/logging";
import { commandAvailability } from "./command-availability";

const logger = createLogger("commands.admission");

export function admitCommand(backend: AgentBackendId, command: string) {
  const availability = commandAvailability(
    catalogEntryFromDescriptor(getBackendDescriptor(backend)),
    command,
  );
  if (availability.status === "unavailable") {
    logger.warn("backend.execution_admission_rejected", availability.refusal);
    throw new BackendAdmissionError(availability.refusal);
  }
  return availability;
}
