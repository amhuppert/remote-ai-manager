/**
 * Lane state persistence for the workflow primitive layer.
 *
 * Defines the storage seam used by the lane service. The default
 * `createInMemoryLaneStore()` keeps lanes scoped by `(workflowId, laneId)`
 * so identical lane names belonging to different workflows never collide.
 * Adapter-backed stores (graph workflow, future session-state-backed
 * implementations) implement the same interface.
 */

import { createLogger } from "@/lib/logging";
import type { SessionState } from "@/types";
import {
  laneStateSchema,
  laneStorageKey,
  type LaneRef,
  type LaneState,
} from "./lane-vocabulary";

const logger = createLogger("workflows.primitives.lane.store");

export interface LaneStore {
  read(ref: LaneRef): Promise<LaneState | null>;
  write(state: LaneState): Promise<void>;
  delete(ref: LaneRef): Promise<void>;
  listByWorkflow(workflowId: string): Promise<LaneState[]>;
}

export function createInMemoryLaneStore(): LaneStore {
  const records = new Map<string, LaneState>();

  return {
    async read(ref) {
      const key = laneStorageKey(ref);
      const found = records.get(key);
      return found ? cloneState(found) : null;
    },

    async write(state) {
      const parsed = laneStateSchema.parse(state);
      const key = laneStorageKey({
        workflowId: parsed.workflowId,
        laneId: parsed.laneId,
      });
      records.set(key, cloneState(parsed));
      logger.debug("lane.store.write", {
        workflowId: parsed.workflowId,
        laneId: parsed.laneId,
        backend: parsed.backend,
      });
    },

    async delete(ref) {
      const key = laneStorageKey(ref);
      const removed = records.delete(key);
      if (removed) {
        logger.debug("lane.store.delete", {
          workflowId: ref.workflowId,
          laneId: ref.laneId,
        });
      }
    },

    async listByWorkflow(workflowId) {
      const matches: LaneState[] = [];
      for (const state of records.values()) {
        if (state.workflowId === workflowId) {
          matches.push(cloneState(state));
        }
      }
      return matches;
    },
  };
}

function cloneState(state: LaneState): LaneState {
  return structuredClone(state);
}

export interface SessionStateLaneStoreDeps {
  mutateSession: <T>(
    projectPath: string,
    sessionName: string,
    label: string,
    mutate: (session: SessionStateLaneStoreSessionLike) => T | Promise<T>,
  ) => Promise<T>;
  getSession: (
    projectPath: string,
    sessionName: string,
  ) => Promise<SessionStateLaneStoreSessionLike | null>;
  projectPath: string;
  sessionName: string;
}

export interface SessionStateLaneStoreSessionLike {
  workflowLanes?: Record<string, unknown>;
}

export function createSessionStateLaneStore(
  deps: SessionStateLaneStoreDeps,
): LaneStore {
  const { mutateSession, getSession, projectPath, sessionName } = deps;

  return {
    async read(ref) {
      const session = await getSession(projectPath, sessionName);
      const raw = session?.workflowLanes?.[laneStorageKey(ref)];
      if (raw === undefined) return null;
      return laneStateSchema.parse(raw);
    },

    async write(state) {
      const parsed = laneStateSchema.parse(state);
      const key = laneStorageKey({
        workflowId: parsed.workflowId,
        laneId: parsed.laneId,
      });
      await mutateSession(
        projectPath,
        sessionName,
        `workflow-lane.write[${parsed.workflowId}/${parsed.laneId}]`,
        (session) => {
          if (!session.workflowLanes) session.workflowLanes = {};
          session.workflowLanes[key] = parsed;
          logger.debug("lane.store.write", {
            workflowId: parsed.workflowId,
            laneId: parsed.laneId,
            backend: parsed.backend,
            backing: "session-state",
          });
        },
      );
    },

    async delete(ref) {
      const key = laneStorageKey(ref);
      await mutateSession(
        projectPath,
        sessionName,
        `workflow-lane.delete[${ref.workflowId}/${ref.laneId}]`,
        (session) => {
          if (!session.workflowLanes) return;
          if (key in session.workflowLanes) {
            delete session.workflowLanes[key];
            logger.debug("lane.store.delete", {
              workflowId: ref.workflowId,
              laneId: ref.laneId,
              backing: "session-state",
            });
          }
        },
      );
    },

    async listByWorkflow(workflowId) {
      const session = await getSession(projectPath, sessionName);
      const collection = session?.workflowLanes ?? {};
      const matches: LaneState[] = [];
      for (const raw of Object.values(collection)) {
        const parsed = laneStateSchema.parse(raw);
        if (parsed.workflowId === workflowId) {
          matches.push(parsed);
        }
      }
      return matches;
    },
  };
}

interface StateModuleAccessors {
  mutateSession: SessionStateLaneStoreDeps["mutateSession"];
  getSession: (
    projectPath: string,
    sessionName: string,
  ) => Promise<SessionState | null>;
}

async function loadStateAccessors(): Promise<StateModuleAccessors> {
  const stateModule: StateModuleAccessors = await import("@/lib/state");
  return {
    mutateSession: stateModule.mutateSession,
    getSession: stateModule.getSession,
  };
}

export function createSessionLaneStoreForProduction(input: {
  projectPath: string;
  sessionName: string;
}): LaneStore {
  return createSessionStateLaneStore({
    projectPath: input.projectPath,
    sessionName: input.sessionName,
    mutateSession: async (...args) =>
      (await loadStateAccessors()).mutateSession(...args),
    getSession: async (...args) =>
      (await loadStateAccessors()).getSession(
        ...args,
      ) as Promise<SessionStateLaneStoreSessionLike | null>,
  });
}
