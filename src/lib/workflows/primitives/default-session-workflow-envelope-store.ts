/**
 * Default session-scoped WorkflowEnvelopeStore / Repository factories.
 *
 * Production wiring layer between the primitive `createSessionStateWorkflow
 * EnvelopeStore` (which expects an injected `mutateSession` / `getSession`
 * pair) and the singleton state manager exported from `@/lib/state-store`. Long-
 * running primitive-native workflows (Collaboration Mode is the first) call
 * `createSessionWorkflowEnvelopeStoreForProduction({ projectPath, sessionName
 * })` to obtain a store backed by the session-state store, inheriting the
 * session-state write queue automatically.
 *
 * The state-module accessors are resolved lazily through `require()` to mirror
 * the dynamic-import deferral pattern used in `default-session-status-bus.ts`
 * and `default-session-artifact-registry.ts`. This avoids bootstrapping the
 * state manager during module initialization and keeps test paths free to
 * inject their own implementations.
 */
import type { SessionState } from "@/lib/sessions/schemas";
import {
  createSessionStateWorkflowEnvelopeStore,
  type SessionStateLike,
  type SessionStateWorkflowEnvelopeStoreDeps,
  type WorkflowEnvelopeStore,
} from "./workflow-envelope-store";
import {
  createWorkflowEnvelopeRepository,
  type WorkflowEnvelopeRepository,
} from "./workflow-envelope-repository";

export interface DefaultSessionWorkflowEnvelopeStoreDeps {
  projectPath: string;
  sessionName: string;
  mutateSession: SessionStateWorkflowEnvelopeStoreDeps["mutateSession"];
  getSession: (
    projectPath: string,
    sessionName: string,
  ) => Promise<SessionState | null>;
}

export function createDefaultSessionWorkflowEnvelopeStore(
  deps: DefaultSessionWorkflowEnvelopeStoreDeps,
): WorkflowEnvelopeStore {
  return createSessionStateWorkflowEnvelopeStore({
    projectPath: deps.projectPath,
    sessionName: deps.sessionName,
    mutateSession: deps.mutateSession,
    getSession: async (projectPath, sessionName) => {
      const session = await deps.getSession(projectPath, sessionName);
      return session as SessionStateLike | null;
    },
  });
}

export function createDefaultSessionWorkflowEnvelopeRepository(
  deps: DefaultSessionWorkflowEnvelopeStoreDeps,
): WorkflowEnvelopeRepository {
  return createWorkflowEnvelopeRepository({
    store: createDefaultSessionWorkflowEnvelopeStore(deps),
  });
}

interface StateModuleAccessors {
  mutateSession: SessionStateWorkflowEnvelopeStoreDeps["mutateSession"];
  getSession: (
    projectPath: string,
    sessionName: string,
  ) => Promise<SessionState | null>;
}

function loadStateAccessors(): StateModuleAccessors {
  const stateModule: StateModuleAccessors =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require("@/lib/state-store");
  return {
    mutateSession: stateModule.mutateSession,
    getSession: stateModule.getSession,
  };
}

export function createSessionWorkflowEnvelopeStoreForProduction(input: {
  projectPath: string;
  sessionName: string;
}): WorkflowEnvelopeStore {
  return createDefaultSessionWorkflowEnvelopeStore({
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    mutateSession: (...args) => loadStateAccessors().mutateSession(...args),
    getSession: (...args) => loadStateAccessors().getSession(...args),
  });
}

export function createSessionWorkflowEnvelopeRepositoryForProduction(input: {
  projectPath: string;
  sessionName: string;
}): WorkflowEnvelopeRepository {
  return createWorkflowEnvelopeRepository({
    store: createSessionWorkflowEnvelopeStoreForProduction(input),
  });
}
