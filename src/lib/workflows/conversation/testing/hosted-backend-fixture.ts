import { runtimeConfigurationFixture } from "./runtime-configuration-fixture";
import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import {
  registerRuntime,
  unregisterRuntime,
} from "@/lib/agent-backends/runtime-registry";
import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import {
  conversationRuntimeKey,
  getConversationRuntime,
} from "../runtime-state";
import { createConversationManagerFixture } from "./manager-fixture";

export function createHostedBackendFixture(
  projectPath = "/fixture",
  sessionName = "session",
) {
  const fixture = createConversationManagerFixture();
  return {
    ...fixture,
    async install(conversationId: string, backend: ConversationBackendRuntime) {
      await fixture.manager.ensureConversationLifecycle({
        kind: "ephemeral",
        address: {
          projectPath,
          target: targetFromStoreSessionName(
            "fixture",
            sessionName,
            conversationId,
          ),
        },
        backend: backend.backend,
        role: null,
        worktreePath: `${projectPath}/.worktrees/${sessionName}`,
      });
      const runtime = getConversationRuntime(
        conversationRuntimeKey(projectPath, sessionName, conversationId),
      );
      if (!runtime) throw new Error("Fixture host was not created");
      runtime.managed.install(
        runtime.managed.beginCreation(),
        backend,
        runtimeConfigurationFixture({
          backend: backend.backend,
          modelSelection: backend.modelSelection,
          outputFormat: backend.outputFormat,
          fsWritePolicy: backend.fsWritePolicy,
        }),
        {
          register: registerRuntime,
          unregister: unregisterRuntime,
        },
      );
      return runtime;
    },
  };
}
