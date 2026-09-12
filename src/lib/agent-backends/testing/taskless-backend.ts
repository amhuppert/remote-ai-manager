import type { AgentBackendId } from "@/lib/shared/schemas";
import { listBackends } from "../registry";
import {
  _registerBackendForTesting,
  _resetBackendRegistryForTesting,
} from "../registry-core";

export async function withTasklessBackend<T>(
  backend: AgentBackendId,
  run: () => Promise<T>,
): Promise<T> {
  const descriptors = listBackends();
  _resetBackendRegistryForTesting();
  try {
    for (const descriptor of descriptors)
      _registerBackendForTesting(
        descriptor.id === backend
          ? { ...descriptor, tasks: undefined }
          : descriptor,
      );
    return await run();
  } finally {
    _resetBackendRegistryForTesting();
    for (const descriptor of descriptors)
      _registerBackendForTesting(descriptor);
  }
}
