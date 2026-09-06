import type { BackendCatalogEntry } from "./catalog";
import type { BackendAdmissionRefusal } from "./execution-admission";
import type { AgentBackendId } from "@/lib/shared/schemas";

export function backendForkRefusal(
  entry: Pick<BackendCatalogEntry, "id" | "label"> & {
    capabilities: { fork: "native" | "synthetic" | "unsupported" } | null;
  },
  messageIndex: number,
  role: string,
): BackendAdmissionRefusal | null {
  if (messageIndex === 0 && role === "user") return null;
  if (entry.capabilities && entry.capabilities.fork !== "unsupported")
    return null;
  return {
    backend: entry.id,
    operation: "fork",
    code: "backend-fork-unsupported",
    message: `${entry.label} cannot fork this conversation with its history.`,
  };
}

export function backendForkRefusalIn(
  entries: readonly BackendCatalogEntry[],
  backend: AgentBackendId,
  messageIndex: number,
  role: string,
): BackendAdmissionRefusal | null {
  if (messageIndex === 0 && role === "user") return null;
  const entry = entries.find((candidate) => candidate.id === backend);
  return entry
    ? backendForkRefusal(entry, messageIndex, role)
    : {
        backend,
        operation: "fork",
        code: "backend-catalog-unavailable",
        message: `Fork availability for ${backend} is unavailable`,
      };
}
