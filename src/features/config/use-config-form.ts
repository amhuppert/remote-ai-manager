import { useCallback, useMemo, useState } from "react";
import type {
  FullConfigResponse,
  GlobalConfig,
  RawGlobalConfig,
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
  invalidCount: number;
  buildSavePayload(): RawGlobalConfig | null;
  applySaved(data: FullConfigResponse): void;
  revert(): void;
}

export function useConfigForm(
  queryData: FullConfigResponse | undefined,
): UseConfigFormResult {
  const [formState, setFormState] = useState<GlobalConfig | null>(null);
  const [loadedData, setLoadedData] = useState<FullConfigResponse | null>(null);
  const [invalidFieldPaths, setInvalidFieldPaths] = useState<Set<FieldPath>>(
    () => new Set(),
  );
  const [formRevision, setFormRevision] = useState(0);

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

  const handleValidityChange = useCallback(
    (path: FieldPath, valid: boolean) => {
      setInvalidFieldPaths((current) => {
        const isInvalid = current.has(path);
        if (valid === !isInvalid) return current;
        const next = new Set(current);
        if (valid) next.delete(path);
        else next.add(path);
        return next;
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
      formRevision,
      handleChange,
      handleChangeMulti,
      handleChangeBlock,
      isDefault,
      isModified,
      handleValidityChange,
    };
  }, [
    formState,
    formRevision,
    handleChange,
    handleChangeMulti,
    handleChangeBlock,
    isDefault,
    isModified,
    handleValidityChange,
  ]);

  const buildSavePayload = useCallback((): RawGlobalConfig | null => {
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

    return stripUndefinedDeep(result) as RawGlobalConfig;
  }, [formState, loadedData]);

  const applySaved = useCallback((data: FullConfigResponse) => {
    setFormState(data.config);
    setLoadedData(data);
    setInvalidFieldPaths(new Set());
    setFormRevision((current) => current + 1);
  }, []);

  const revert = useCallback(() => {
    if (!loadedData) return;
    setFormState(loadedData.config);
    setInvalidFieldPaths(new Set());
    setFormRevision((current) => current + 1);
  }, [loadedData]);

  return {
    controller,
    loadedData,
    dirtyCount,
    invalidCount: invalidFieldPaths.size,
    buildSavePayload,
    applySaved,
    revert,
  };
}
