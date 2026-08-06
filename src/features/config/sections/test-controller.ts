import type { GlobalConfig, WorkflowDefaults } from "@/lib/config/schemas";
import {
  deepGet,
  deepSet,
  deepEqual,
  SEEDED_WORKFLOW_DEFAULTS,
} from "../form-state";
import type { FieldPath, WorkflowDefaultsBlock } from "../form-state";
import type { ConfigFormController } from "./types";

export const baseFormState: GlobalConfig = {
  baseDir: "/home/user/projects",
  defaultAgentBackend: "claude",
  agentBackends: {
    claude: {
      model: "opus",
      reasoningEffort: "high",
      timeoutMs: 3_600_000,
    },
    codex: {
      fastMode: false,
      model: "gpt-5.4",
      reasoningEffort: "high",
      timeoutMs: null,
    },
  },
  maxConcurrentQueries: 3,
  preMergeTimeoutMs: 300_000,
  validation: {
    concurrencyLimit: 8,
    defaultTimeoutMs: 600_000,
  },
  ignorePatterns: ["node_modules", ".next"],
  tailscaleEnabled: false,
  workflowDefaults: structuredClone(SEEDED_WORKFLOW_DEFAULTS),
};

export function makeController(initial: Partial<GlobalConfig> = {}): {
  controller: ConfigFormController;
  getState: () => GlobalConfig;
} {
  let state: GlobalConfig = {
    ...structuredClone(baseFormState),
    ...initial,
  };
  const loaded = structuredClone(state);

  const controller: ConfigFormController = {
    formRevision: 0,
    get formState() {
      return state;
    },
    handleChange(path: FieldPath, value: unknown) {
      state = deepSet(state, path, value);
    },
    handleChangeMulti(changes) {
      for (const [path, value] of changes) {
        state = deepSet(state, path, value);
      }
    },
    handleChangeBlock<K extends WorkflowDefaultsBlock>(
      block: K,
      value: WorkflowDefaults[K],
    ) {
      const existing =
        state.workflowDefaults ?? structuredClone(SEEDED_WORKFLOW_DEFAULTS);
      state = { ...state, workflowDefaults: { ...existing, [block]: value } };
    },
    isDefault: () => true,
    isModified(path: FieldPath) {
      return !deepEqual(deepGet(loaded, path), deepGet(state, path));
    },
    handleValidityChange() {},
  };

  return { controller, getState: () => state };
}
