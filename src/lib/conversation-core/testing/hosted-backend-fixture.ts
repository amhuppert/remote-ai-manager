import type { ConversationBackendRuntime } from "@/lib/agent-backends/conversation";
import {
  registerRuntime,
  unregisterRuntime,
} from "@/lib/agent-backends/runtime-registry";
import { targetFromStoreSessionName } from "@/lib/conversations/conversation-target";
import { createCapturingLogger } from "@/lib/shared/testing/capturing-logger";
import { createRuntimeHost } from "../runtime-host";

/** The real core runtime host, with only provider construction replaced. */
export function createHostedBackendFixture(
  projectPath = "/fixture",
  sessionName = "session",
) {
  const providers = new Map<string, ConversationBackendRuntime>();
  const instructions = async () => ({
    sessionInstructions: [],
    alignmentVersion: null,
    alignmentEligible: false,
  });
  const host = createRuntimeHost({
    factory: (backend) => ({
      backend,
      async createRuntime(input) {
        const runtime = providers.get(input.conversationId);
        if (runtime === undefined)
          throw new Error("Fixture backend was not installed");
        return runtime;
      },
      async validateModelSelection() {
        throw new Error("The fixture does not admit model selections");
      },
    }),
    instructions,
    readInstructions: instructions,
    tooling: async () => ({ overrides: { portableMcp: { servers: [] } } }),
    beginSeed: async () => ({ commit: async () => {} }),
    callbacks: () => ({}),
    index: { register: registerRuntime, unregister: unregisterRuntime },
    log: createCapturingLogger(),
  });
  return {
    host,
    dispose() {
      providers.clear();
    },
    shutdown: () => host.releaseAll(),
    retire: (conversationId: string) => host.release(conversationId),
    async install(conversationId: string, runtime: ConversationBackendRuntime) {
      providers.set(conversationId, runtime);
      await host.obtain(
        {
          projectPath,
          projectName: "fixture",
          conversationId,
          target: targetFromStoreSessionName(
            "fixture",
            sessionName,
            conversationId,
          ),
          worktreePath: `${projectPath}/.worktrees/${sessionName}`,
          backend: runtime.backend,
          executionClass: "governed-execution",
          persistedRef: null,
        },
        {
          modelSelection: runtime.modelSelection,
          ...(runtime.fsWritePolicy !== undefined
            ? { fsWritePolicy: runtime.fsWritePolicy }
            : {}),
          instructionSelection: { autonomous: false },
        },
      );
    },
  };
}
