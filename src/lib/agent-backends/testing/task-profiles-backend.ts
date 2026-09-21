import type { AgentBackendId } from "@/lib/shared/schemas";
import type { TaskExecutionProfile } from "../execution-admission";
import { listBackends } from "../registry";
import {
  _registerBackendForTesting,
  _resetBackendRegistryForTesting,
} from "../registry-core";

export async function withTaskProfiles<T>(
  backend: AgentBackendId,
  profiles: TaskExecutionProfile[],
  run: () => Promise<T>,
): Promise<T> {
  const descriptors = listBackends();
  _resetBackendRegistryForTesting();
  try {
    for (const descriptor of descriptors) {
      if (descriptor.id !== backend) {
        _registerBackendForTesting(descriptor);
        continue;
      }
      if (!descriptor.tasks) throw new Error(`${backend} has no task facet`);
      _registerBackendForTesting({
        ...descriptor,
        tasks: {
          ...descriptor.tasks,
          execution: { ...descriptor.tasks.execution, profiles },
        },
      });
    }
    return await run();
  } finally {
    _resetBackendRegistryForTesting();
    for (const descriptor of descriptors)
      _registerBackendForTesting(descriptor);
  }
}
