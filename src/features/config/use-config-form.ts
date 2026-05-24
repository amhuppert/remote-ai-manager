import { useCallback, useMemo, useState } from "react";
import type {
  FullConfigResponse,
  GlobalConfig,
  WorkflowDefaults,
} from "@/lib/config/schemas";
import {
  ALL_FIELD_PATHS,
  deepEqual,
  deepGet,
  deepSet,
  SEEDED_WORKFLOW_DEFAULTS,
  stripUndefinedDeep,
} from "./form-state";
import type { FieldPath, WorkflowDefaultsBlock } from "./form-state";
import type { ConfigFormController } from "./sections/types";

export interface UseConfigFormResult {
  controller: ConfigFormController | null;
  loadedData: FullConfigResponse | null;
  dirtyCount: number;
  buildSavePayload(): Partial<GlobalConfig> | null;
  applySaved(data: FullConfigResponse): void;
  revert(): void;
}

export function useConfigForm(
  queryData: FullConfigResponse | undefined,
): UseConfigFormResult {
  const [formState, setFormState] = useState<GlobalConfig | null>(null);
  const [loadedData, setLoadedData] = useState<FullConfigResponse | null>(null);

  if (queryData && !formState) {
    setFormState(queryData.config);
    setLoadedData(queryData);
  }

  const handleChange = useCallback((path: FieldPath, value: unknown) => {
    setFormState((prev) => (prev ? deepSet(prev, path, value) : prev));
  }, []);

  const handleChangeMulti = useCallback(
    (changes: Array<[FieldPath, unknown]>) => {
      setFormState((prev) => {
        if (!prev) return prev;
        let state = prev;
        for (const [path, value] of changes) {
          state = deepSet(state, path, value);
        }
        return state;
      });
    },
    [],
  );

  const handleChangeBlock = useCallback(
    <K extends WorkflowDefaultsBlock>(block: K, value: WorkflowDefaults[K]) => {
      setFormState((prev) => {
        if (!prev) return prev;
        const existing =
          prev.workflowDefaults ?? structuredClone(SEEDED_WORKFLOW_DEFAULTS);
        return {
          ...prev,
          workflowDefaults: { ...existing, [block]: value },
        };
      });
    },
    [],
  );

  const isDefault = useCallback(
    (path: FieldPath): boolean => {
      if (!loadedData) return false;
      const rawValue = deepGet(loadedData.raw, path);
      const formValue = formState ? deepGet(formState, path) : undefined;
      const loadedValue = deepGet(loadedData.config, path);
      if (!deepEqual(formValue, loadedValue)) return false;
      return rawValue === undefined;
    },
    [loadedData, formState],
  );

  const isModified = useCallback(
    (path: FieldPath): boolean => {
      if (!loadedData || !formState) return false;
      return !deepEqual(
        deepGet(loadedData.config, path),
        deepGet(formState, path),
      );
    },
    [loadedData, formState],
  );

  const dirtyCount = useMemo(
    () => ALL_FIELD_PATHS.filter((p) => isModified(p)).length,
    [isModified],
  );

  const controller = useMemo<ConfigFormController | null>(() => {
    if (!formState) return null;
    return {
      formState,
      handleChange,
      handleChangeMulti,
      handleChangeBlock,
      isDefault,
      isModified,
    };
  }, [
    formState,
    handleChange,
    handleChangeMulti,
    handleChangeBlock,
    isDefault,
    isModified,
  ]);

  const buildSavePayload = useCallback((): Partial<GlobalConfig> | null => {
    if (!formState || !loadedData) return null;
    const result: Record<string, unknown> = structuredClone(
      loadedData.raw as Record<string, unknown>,
    );

    for (const path of ALL_FIELD_PATHS) {
      const formValue = deepGet(formState, path);
      const loadedValue = deepGet(loadedData.config, path);

      if (!deepEqual(formValue, loadedValue)) {
        const keys = path.split(".");
        let cur = result;
        for (let i = 0; i < keys.length - 1; i++) {
          const k = keys[i]!;
          if (cur[k] == null || typeof cur[k] !== "object") {
            cur[k] = {};
          }
          cur = cur[k] as Record<string, unknown>;
        }
        cur[keys[keys.length - 1]!] = formValue;
      }
    }

    return stripUndefinedDeep(result) as Partial<GlobalConfig>;
  }, [formState, loadedData]);

  const applySaved = useCallback((data: FullConfigResponse) => {
    setFormState(data.config);
    setLoadedData(data);
  }, []);

  const revert = useCallback(() => {
    if (!loadedData) return;
    setFormState(loadedData.config);
  }, [loadedData]);

  return {
    controller,
    loadedData,
    dirtyCount,
    buildSavePayload,
    applySaved,
    revert,
  };
}
