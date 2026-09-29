import {
  createGraphWorkflowManager,
  type GraphWorkflowManagerDeps,
} from "../workflow-manager";

type ExternalLifecyclePorts =
  | "readSessionFinalizingMerge"
  | "clearConversationQuestion";

export type GraphWorkflowManagerFixtureDeps = Omit<
  GraphWorkflowManagerDeps,
  ExternalLifecyclePorts
> &
  Partial<Pick<GraphWorkflowManagerDeps, ExternalLifecyclePorts>>;

/** Real graph lifecycle over caller-owned state, with no external merge or conversation. */
export function createGraphWorkflowManagerFixture(
  deps: GraphWorkflowManagerFixtureDeps,
) {
  return createGraphWorkflowManager({
    readSessionFinalizingMerge: () => null,
    clearConversationQuestion: async () => false,
    ...deps,
  });
}
