import {
  PROJECT_CC_CONTEXT,
  PROJECT_SPAWN_INSTRUCTIONS,
} from "@/lib/project-conversations/system-prompt";
import { runtimeConfigurationFixture } from "./runtime-configuration-fixture";
import type { DesiredRuntimeConfiguration } from "../pre-turn/runtime-recreate";
import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import { ManagedConversationRuntime } from "../runtime-binding";

export function createManagedRuntimeFixture(
  key: string,
  backend?: ConversationBackendRuntime,
  configuration?: Partial<DesiredRuntimeConfiguration>,
): ManagedConversationRuntime {
  const owner = new ManagedConversationRuntime(key.split("::").at(-1) ?? key);
  if (backend)
    owner.install(
      owner.beginCreation(),
      backend,
      runtimeConfigurationFixture({
        backend: backend.backend,
        modelSelection: backend.modelSelection,
        fsWritePolicy: backend.fsWritePolicy,
        ...(key.split("::")[1] === "__project__"
          ? {
              repeatableInstructions: [
                PROJECT_CC_CONTEXT,
                ...runtimeConfigurationFixture().repeatableInstructions.slice(
                  1,
                ),
                PROJECT_SPAWN_INSTRUCTIONS,
              ],
            }
          : {}),
        ...configuration,
      }),
      {
        register() {},
        unregister() {},
      },
    );
  return owner;
}
