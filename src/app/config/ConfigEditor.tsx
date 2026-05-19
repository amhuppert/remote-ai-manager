"use client";

import { useState, useCallback, useMemo } from "react";
import Topbar from "@/components/Topbar";
import ModelSelector from "@/components/ModelSelector";
import ReasoningLevelSelector from "@/components/ReasoningLevelSelector";
import { AgentCapabilitiesConfigurator } from "@/components/agent-capabilities/AgentCapabilitiesConfigurator";
import type { AgentCapabilityLayerOption } from "@/components/agent-capabilities/AgentCapabilityPanel";
import { useFullConfigQuery } from "@/lib/queries";
import { useUpdateConfigMutation } from "@/lib/mutations";
import type { FullConfigResponse } from "@/lib/api-client";
import type {
  AgentBackendId,
  EffortLevel,
  ClaudeModel,
  CodexModel,
  CodexReasoningEffort,
  WorkflowDefaults,
  GraphWorkflowAgentConfig,
  GraphWorkflowAgentValidatorConfig,
  GraphWorkflowIterationPolicy,
  GraphWorkflowCircuitBreakerPolicy,
  GraphWorkflowMutabilityPolicy,
  GraphWorkflowScriptValidatorConfig,
} from "@/lib/schemas";
import type { GlobalConfig } from "@/types";
import {
  formatFieldLabel,
  msToMinutes,
  minutesToMs,
  validateNumericInput,
  getModelOptionsForBackend,
  getEffortOptionsForBackend,
} from "./config-helpers";

// ---------------------------------------------------------------------------
// Seeded workflow defaults (mirror src/lib/config.ts defaultConfig())
// ---------------------------------------------------------------------------

export const SEEDED_WORKFLOW_DEFAULTS: WorkflowDefaults = {
  implementer: {
    backend: "claude",
    model: "opus",
    reasoningEffort: "medium",
  },
  contextValidator: {
    type: "claude",
    enabled: true,
    continuity: { enabled: true },
    agent: {
      backend: "claude",
      model: "sonnet",
      reasoningEffort: "medium",
    },
  },
  scriptValidator: {
    enabled: false,
  },
  iterationPolicy: {
    maxIterations: 20,
    continuity: { enabled: true },
  },
  circuitBreaker: {
    consecutiveFailureThreshold: 3,
  },
  mutability: {
    allowAgentTaskAdd: false,
  },
};

type WorkflowDefaultsBlock = keyof WorkflowDefaults;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FormState = GlobalConfig;

/** Dot-separated path into the config object (e.g. "pushNotification.enabled") */
type FieldPath = string;
type ConfigNavSection =
  | "general"
  | "defaults"
  | "capabilities"
  | "backends"
  | "workflow"
  | "limits"
  | "notifications";

const CONFIG_NAV: Array<{ id: ConfigNavSection; label: string }> = [
  { id: "general", label: "General" },
  { id: "defaults", label: "Agent defaults" },
  { id: "capabilities", label: "Capabilities" },
  { id: "backends", label: "Backends" },
  { id: "workflow", label: "Workflow defaults" },
  { id: "limits", label: "Limits & timeouts" },
  { id: "notifications", label: "Notifications" },
];

// ---------------------------------------------------------------------------
// Helpers — deep get/set by dot-path
// ---------------------------------------------------------------------------

function deepGet(obj: unknown, path: FieldPath): unknown {
  const keys = path.split(".");
  let cur: unknown = obj;
  for (const k of keys) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function deepSet<T>(obj: T, path: FieldPath, value: unknown): T {
  const keys = path.split(".");
  const clone = structuredClone(obj);
  let cur: Record<string, unknown> = clone as Record<string, unknown>;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i]!;
    if (cur[k] == null || typeof cur[k] !== "object") {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]!] = value;
  return clone;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => deepEqual(aObj[k], bObj[k]));
}

function stripUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item));
  }

  if (value == null || typeof value !== "object") {
    return value;
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    const stripped = stripUndefinedDeep(entry);
    if (
      stripped &&
      typeof stripped === "object" &&
      !Array.isArray(stripped) &&
      Object.keys(stripped).length === 0
    ) {
      continue;
    }
    result[key] = stripped;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ConfigField({
  label,
  fieldPath,
  isDefault,
  isModified,
  readOnly,
  hint,
  children,
}: {
  label: string;
  fieldPath: string;
  isDefault: boolean;
  isModified: boolean;
  readOnly?: boolean;
  hint?: string;
  children: React.ReactNode;
}) {
  const cls = [
    "config-field",
    isModified ? "modified" : "",
    readOnly ? "config-field-readonly" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls} data-field={fieldPath}>
      <div className="config-field-header">
        <span className="config-field-label">{label}</span>
        {readOnly && <span className="config-field-lock">LOCKED</span>}
        {isDefault && <span className="config-badge-default">DEFAULT</span>}
      </div>
      {children}
      {hint && <div className="form-hint">{hint}</div>}
    </div>
  );
}

function ConfigToggle({
  value,
  onChange,
  disabled,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div
      className="config-toggle"
      onClick={() => !disabled && onChange(!value)}
      role="switch"
      aria-checked={value}
      tabIndex={0}
      onKeyDown={(e) => {
        if (!disabled && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          onChange(!value);
        }
      }}
    >
      <div className={`config-toggle-track${value ? " active" : ""}`}>
        <div className="config-toggle-knob" />
      </div>
      <span className="config-toggle-label">{value ? "ON" : "OFF"}</span>
    </div>
  );
}

function ConfigPillGroup<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: readonly T[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="config-pill-group">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          className={`config-pill-btn${value === opt ? " active" : ""}`}
          onClick={() => !disabled && onChange(opt)}
          disabled={disabled}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function ConfigNumericInput({
  value,
  onChange,
  displayAsMinutes,
  required,
  positive,
  integer,
  placeholder,
}: {
  value: number | null | undefined;
  onChange: (v: number | null | undefined) => void;
  displayAsMinutes?: boolean;
  required?: boolean;
  positive?: boolean;
  integer?: boolean;
  placeholder?: string;
}) {
  const toDisplay = (v: number | null | undefined): string => {
    if (v == null) return "";
    return String(displayAsMinutes ? msToMinutes(v) : v);
  };

  const [localStr, setLocalStr] = useState(() => toDisplay(value));
  const [error, setError] = useState<string | null>(null);
  const [prevValue, setPrevValue] = useState(value);

  // Sync from props when value changes externally (e.g. after save)
  if (prevValue !== value) {
    setPrevValue(value);
    setLocalStr(toDisplay(value));
    setError(null);
  }

  const handleInput = (text: string) => {
    setLocalStr(text);
    const result = validateNumericInput(text, { required, positive, integer });
    if (!result.valid) {
      setError(result.error ?? null);
      return;
    }
    setError(null);
    if (result.value === undefined) {
      onChange(undefined);
    } else {
      onChange(displayAsMinutes ? minutesToMs(result.value) : result.value);
    }
  };

  return (
    <>
      <input
        className={`form-input${error ? " form-input-error" : ""}`}
        type="text"
        inputMode="decimal"
        value={localStr}
        onChange={(e) => handleInput(e.target.value)}
        placeholder={placeholder}
      />
      {error && <div className="form-error">{error}</div>}
    </>
  );
}

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export default function ConfigEditor(): React.JSX.Element {
  const configQuery = useFullConfigQuery();
  const mutation = useUpdateConfigMutation();

  const [formState, setFormState] = useState<FormState | null>(null);
  const [loadedData, setLoadedData] = useState<FullConfigResponse | null>(null);
  const [activeSection, setActiveSection] =
    useState<ConfigNavSection>("general");

  // Initialize form state from query data (during render, not in effect)
  if (configQuery.data && !formState) {
    setFormState(configQuery.data.config);
    setLoadedData(configQuery.data);
  }

  const handleChangeBlock = useCallback(
    <K extends WorkflowDefaultsBlock>(block: K, value: WorkflowDefaults[K]) => {
      setFormState((prev) => {
        if (!prev) return prev;
        const existing =
          prev.workflowDefaults ?? structuredClone(SEEDED_WORKFLOW_DEFAULTS);
        const nextDefaults: WorkflowDefaults = {
          ...existing,
          [block]: value,
        };
        return { ...prev, workflowDefaults: nextDefaults };
      });
    },
    [],
  );

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

  const isDefault = useCallback(
    (path: FieldPath): boolean => {
      if (!loadedData) return false;
      // A field is "default" if it wasn't explicitly in the raw config AND
      // the user hasn't modified it from the loaded value
      const rawValue = deepGet(loadedData.raw, path);
      const formValue = formState ? deepGet(formState, path) : undefined;
      const loadedValue = deepGet(loadedData.config, path);
      // If user modified it from loaded, it's no longer default
      if (!deepEqual(formValue, loadedValue)) return false;
      return rawValue === undefined;
    },
    [loadedData, formState],
  );

  const isModified = useCallback(
    (path: FieldPath): boolean => {
      if (!loadedData || !formState) return false;
      const loaded = deepGet(loadedData.config, path);
      const current = deepGet(formState, path);
      return !deepEqual(loaded, current);
    },
    [loadedData, formState],
  );

  // All tracked field paths for dirty counting
  const ALL_FIELD_PATHS: FieldPath[] = useMemo(
    () => [
      "baseDir",
      "defaultModel",
      "defaultAgentBackend",
      "defaultEffort",
      "branchPrefix",
      "claudeTimeoutMs",
      "maxTurns",
      "maxConcurrentQueries",
      "mergeCheckIntervalMs",
      "preMergeTimeoutMs",
      "idleQuerySessionTtlMs",
      "tailscaleEnabled",
      "pushNotification.enabled",
      "pushNotification.provider",
      "pushNotification.serverUrl",
      "pushNotification.topic",
      "pushNotification.triggers.jobCompleted",
      "pushNotification.triggers.waitingForInput",
      "pushNotification.triggers.workflowCompleted",
      "pushNotification.triggers.workflowHalted",
      "pushNotification.triggers.conversationIdle",
      "codex.enabled",
      "codex.model",
      "codex.reasoningEffort",
      "codex.timeout",
      "workflowDefaults.implementer",
      "workflowDefaults.contextValidator",
      "workflowDefaults.scriptValidator",
      "workflowDefaults.iterationPolicy",
      "workflowDefaults.circuitBreaker",
      "workflowDefaults.mutability",
    ],
    [],
  );

  const dirtyCount = useMemo(
    () => ALL_FIELD_PATHS.filter((p) => isModified(p)).length,
    [ALL_FIELD_PATHS, isModified],
  );
  const globalCapabilityLayerOptions = useMemo<
    readonly AgentCapabilityLayerOption[]
  >(() => [{ label: "Global", scope: { level: "global" } }], []);

  // Dynamic model/effort paths and options based on selected backend
  const isCodexBackend = formState?.defaultAgentBackend === "codex";
  const coreModelPath = isCodexBackend ? "codex.model" : "defaultModel";
  const coreEffortPath = isCodexBackend
    ? "codex.reasoningEffort"
    : "defaultEffort";
  const coreModelValue = isCodexBackend
    ? (formState?.codex?.model ?? "gpt-5.4")
    : (formState?.defaultModel ?? "opus");
  const coreEffortValue = isCodexBackend
    ? (formState?.codex?.reasoningEffort ?? "medium")
    : (formState?.defaultEffort ?? "medium");

  const effortOptions = useMemo(
    () =>
      formState
        ? getEffortOptionsForBackend(
            formState.defaultAgentBackend,
            formState.defaultAgentBackend === "codex"
              ? (formState.codex?.model ?? "gpt-5.4")
              : formState.defaultModel,
          )
        : [],
    [formState],
  );

  const handleSave = useCallback(() => {
    if (!formState || !loadedData) return;

    // Build partial config with only explicitly set fields:
    // Start from the raw (explicit) config, then overlay any user changes
    const result: Record<string, unknown> = structuredClone(
      loadedData.raw as Record<string, unknown>,
    );

    for (const path of ALL_FIELD_PATHS) {
      const formValue = deepGet(formState, path);
      const loadedValue = deepGet(loadedData.config, path);
      const rawValue = deepGet(loadedData.raw, path);

      if (!deepEqual(formValue, loadedValue)) {
        // User changed this field — ensure it's in the result
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
      } else if (rawValue !== undefined) {
        // Field unchanged and was explicitly set — keep it
      }
    }

    const cleanedResult = stripUndefinedDeep(result) as Partial<GlobalConfig>;

    mutation.mutate(cleanedResult, {
      onSuccess: (data) => {
        setFormState(data.config);
        setLoadedData(data);
      },
    });
  }, [formState, loadedData, ALL_FIELD_PATHS, mutation]);

  // --- Loading / Error states ---
  if (configQuery.isPending) {
    return (
      <div className="app" data-page="config">
        <Topbar breadcrumbs={[{ label: "config" }]} page="projects" />
        <main className="main">
          <div className="empty-state">
            <div className="empty-state-title">Loading configuration...</div>
          </div>
        </main>
      </div>
    );
  }

  if (configQuery.isError || !formState) {
    return (
      <div className="app" data-page="config">
        <Topbar breadcrumbs={[{ label: "config" }]} page="projects" />
        <main className="main">
          <div className="empty-state">
            <div className="empty-state-title">
              Failed to load configuration
            </div>
            <div className="empty-state-desc">
              {configQuery.error?.message ?? "Unknown error"}
            </div>
          </div>
        </main>
      </div>
    );
  }

  const handleRevert = () => {
    if (!loadedData) return;
    setFormState(loadedData.config);
  };

  const renderConfigContent = (): React.JSX.Element => {
    if (activeSection === "capabilities") {
      return (
        <AgentCapabilitiesConfigurator
          layerOptions={globalCapabilityLayerOptions}
          initialScope={{ level: "global" }}
        />
      );
    }

    if (activeSection === "general") {
      return (
        <SettingsPage
          title="General"
          accent="settings"
          sub="Filesystem layout, branch naming and runtime networking."
        >
          <SettingsSubSection
            title="Workspace"
            hint="Where Command Center finds your repositories and how it names new branches."
          >
            <ConfigField
              label="Base directory"
              fieldPath="baseDir"
              isDefault={isDefault("baseDir")}
              isModified={isModified("baseDir")}
              hint="Repositories must live under this path."
            >
              <input
                className="form-input"
                type="text"
                value={formState.baseDir}
                onChange={(e) => handleChange("baseDir", e.target.value)}
              />
            </ConfigField>
            <ConfigField
              label="Branch prefix"
              fieldPath="branchPrefix"
              isDefault={isDefault("branchPrefix")}
              isModified={isModified("branchPrefix")}
              hint='Used when creating session branches (default: "csm").'
            >
              <input
                className="form-input"
                type="text"
                value={formState.branchPrefix ?? ""}
                onChange={(e) =>
                  handleChange("branchPrefix", e.target.value || undefined)
                }
                placeholder="csm"
              />
            </ConfigField>
          </SettingsSubSection>
          <SettingsSubSection title="Infrastructure">
            <ConfigField
              label="Ignore patterns"
              fieldPath="ignorePatterns"
              isDefault={isDefault("ignorePatterns")}
              isModified={false}
              readOnly
              hint="Directories and globs excluded from worktree operations and indexing."
            >
              <div className="config-tags">
                {formState.ignorePatterns.map((pattern) => (
                  <span key={pattern} className="config-tag">
                    {pattern}
                  </span>
                ))}
              </div>
            </ConfigField>
            <ConfigField
              label="Tailscale enabled"
              fieldPath="tailscaleEnabled"
              isDefault={isDefault("tailscaleEnabled")}
              isModified={isModified("tailscaleEnabled")}
              hint="Reach Command Center over your tailnet from a phone or laptop."
            >
              <ConfigToggle
                value={formState.tailscaleEnabled ?? false}
                onChange={(value) => handleChange("tailscaleEnabled", value)}
              />
            </ConfigField>
          </SettingsSubSection>
        </SettingsPage>
      );
    }

    if (activeSection === "defaults") {
      return (
        <SettingsPage
          title="Agent"
          accent="defaults"
          sub="What a new conversation looks like before any per-session override."
        >
          <SettingsSubSection
            title="Default backend"
            hint="Determines which model and effort options apply below."
          >
            <ConfigField
              label="Backend"
              fieldPath="defaultAgentBackend"
              isDefault={isDefault("defaultAgentBackend")}
              isModified={isModified("defaultAgentBackend")}
            >
              <ConfigPillGroup
                value={formState.defaultAgentBackend}
                options={["claude", "codex"] as const}
                onChange={(value) => {
                  handleChangeMulti([
                    ["defaultAgentBackend", value],
                    ["defaultModel", undefined],
                    ["defaultEffort", undefined],
                  ]);
                }}
              />
            </ConfigField>
          </SettingsSubSection>
          <SettingsSubSection title="Model & reasoning">
            <ConfigField
              label="Model"
              fieldPath={coreModelPath}
              isDefault={isDefault(coreModelPath)}
              isModified={isModified(coreModelPath)}
            >
              <ConfigPillGroup
                value={coreModelValue}
                options={getModelOptionsForBackend(
                  formState.defaultAgentBackend,
                )}
                onChange={(value) => handleChange(coreModelPath, value)}
              />
            </ConfigField>
            {effortOptions.length > 0 ? (
              <ConfigField
                label="Effort"
                fieldPath={coreEffortPath}
                isDefault={isDefault(coreEffortPath)}
                isModified={isModified(coreEffortPath)}
              >
                <ConfigPillGroup
                  value={coreEffortValue}
                  options={effortOptions}
                  onChange={(value) => handleChange(coreEffortPath, value)}
                />
              </ConfigField>
            ) : null}
          </SettingsSubSection>
        </SettingsPage>
      );
    }

    if (activeSection === "backends") {
      return (
        <SettingsPage
          title="Agent"
          accent="backends"
          sub="Per-backend runtime settings. Claude is always available; Codex is opt-in."
        >
          <SettingsSubSection
            title="Claude"
            hint="Claude SDK is bundled. Per-conversation defaults live under Agent defaults."
          >
            <div className="config-readout">SDK is bundled and ready.</div>
          </SettingsSubSection>
          <SettingsSubSection title="Codex">
            <ConfigField
              label="Enable Codex"
              fieldPath="codex.enabled"
              isDefault={isDefault("codex.enabled")}
              isModified={isModified("codex.enabled")}
            >
              <ConfigToggle
                value={formState.codex?.enabled ?? false}
                onChange={(value) => handleChange("codex.enabled", value)}
              />
            </ConfigField>
            <ConfigField
              label="Default Codex model"
              fieldPath="codex.model"
              isDefault={isDefault("codex.model")}
              isModified={isModified("codex.model")}
            >
              <ConfigPillGroup
                value={formState.codex?.model ?? "gpt-5.4"}
                options={
                  [
                    "gpt-5.5",
                    "gpt-5.4",
                    "gpt-5.4-mini",
                    "gpt-5.4-nano",
                  ] as const
                }
                onChange={(value) => handleChange("codex.model", value)}
              />
            </ConfigField>
            <ConfigField
              label="Default Codex effort"
              fieldPath="codex.reasoningEffort"
              isDefault={isDefault("codex.reasoningEffort")}
              isModified={isModified("codex.reasoningEffort")}
            >
              <ConfigPillGroup
                value={formState.codex?.reasoningEffort ?? "medium"}
                options={["minimal", "low", "medium", "high", "xhigh"] as const}
                onChange={(value) =>
                  handleChange("codex.reasoningEffort", value)
                }
              />
            </ConfigField>
            <ConfigField
              label="Codex timeout"
              fieldPath="codex.timeout"
              isDefault={isDefault("codex.timeout")}
              isModified={isModified("codex.timeout")}
              hint="Minutes. Empty means no timeout."
            >
              <ConfigNumericInput
                value={formState.codex?.timeout}
                onChange={(value) =>
                  handleChange("codex.timeout", value ?? null)
                }
                displayAsMinutes
                positive
              />
            </ConfigField>
          </SettingsSubSection>
        </SettingsPage>
      );
    }

    if (activeSection === "workflow") {
      return (
        <SettingsPage
          title="Workflow"
          accent="defaults"
          sub="Per-stage configuration used by every new graph workflow."
        >
          <WorkflowDefaultsSubsections
            defaults={formState.workflowDefaults}
            onChangeBlock={handleChangeBlock}
          />
        </SettingsPage>
      );
    }

    if (activeSection === "limits") {
      return (
        <SettingsPage
          title="Limits &"
          accent="timeouts"
          sub="Bounds for runaway agents, idle sessions and pre-merge automation."
        >
          <div className="config-field-row config-field-row--grid">
            <ConfigField
              label="Claude timeout"
              fieldPath="claudeTimeoutMs"
              isDefault={isDefault("claudeTimeoutMs")}
              isModified={isModified("claudeTimeoutMs")}
              hint="minutes"
            >
              <ConfigNumericInput
                value={formState.claudeTimeoutMs}
                onChange={(value) =>
                  handleChange("claudeTimeoutMs", value ?? 3_600_000)
                }
                displayAsMinutes
                required
                positive
              />
            </ConfigField>
            <ConfigField
              label="Max turns"
              fieldPath="maxTurns"
              isDefault={isDefault("maxTurns")}
              isModified={isModified("maxTurns")}
              hint="Hard cap per conversation. Empty means unbounded."
            >
              <ConfigNumericInput
                value={formState.maxTurns}
                onChange={(value) => handleChange("maxTurns", value)}
                positive
                integer
              />
            </ConfigField>
            <ConfigField
              label="Max concurrent queries"
              fieldPath="maxConcurrentQueries"
              isDefault={isDefault("maxConcurrentQueries")}
              isModified={isModified("maxConcurrentQueries")}
            >
              <ConfigNumericInput
                value={formState.maxConcurrentQueries}
                onChange={(value) =>
                  handleChange("maxConcurrentQueries", value)
                }
                positive
                integer
              />
            </ConfigField>
            <ConfigField
              label="Merge check interval"
              fieldPath="mergeCheckIntervalMs"
              isDefault={isDefault("mergeCheckIntervalMs")}
              isModified={isModified("mergeCheckIntervalMs")}
              hint="minutes"
            >
              <ConfigNumericInput
                value={formState.mergeCheckIntervalMs}
                onChange={(value) =>
                  handleChange("mergeCheckIntervalMs", value)
                }
                displayAsMinutes
                positive
              />
            </ConfigField>
            <ConfigField
              label="Pre-merge timeout"
              fieldPath="preMergeTimeoutMs"
              isDefault={isDefault("preMergeTimeoutMs")}
              isModified={isModified("preMergeTimeoutMs")}
              hint="minutes"
            >
              <ConfigNumericInput
                value={formState.preMergeTimeoutMs}
                onChange={(value) => handleChange("preMergeTimeoutMs", value)}
                displayAsMinutes
                positive
              />
            </ConfigField>
            <ConfigField
              label="Idle session TTL"
              fieldPath="idleQuerySessionTtlMs"
              isDefault={isDefault("idleQuerySessionTtlMs")}
              isModified={isModified("idleQuerySessionTtlMs")}
              hint="minutes"
            >
              <ConfigNumericInput
                value={formState.idleQuerySessionTtlMs}
                onChange={(value) =>
                  handleChange("idleQuerySessionTtlMs", value)
                }
                displayAsMinutes
                positive
              />
            </ConfigField>
          </div>
        </SettingsPage>
      );
    }

    return (
      <SettingsPage
        title="Push"
        accent="notifications"
        sub="Get pinged when conversations finish, halt, or wait on you."
      >
        <SettingsSubSection title="Provider">
          <ConfigField
            label="Push notifications enabled"
            fieldPath="pushNotification.enabled"
            isDefault={isDefault("pushNotification.enabled")}
            isModified={isModified("pushNotification.enabled")}
          >
            <ConfigToggle
              value={formState.pushNotification?.enabled ?? false}
              onChange={(value) =>
                handleChange("pushNotification.enabled", value)
              }
            />
          </ConfigField>
          <ConfigField
            label="Provider"
            fieldPath="pushNotification.provider"
            isDefault={isDefault("pushNotification.provider")}
            isModified={isModified("pushNotification.provider")}
          >
            <ConfigPillGroup
              value={formState.pushNotification?.provider ?? "ntfy"}
              options={["ntfy", "pushover"] as const}
              onChange={(value) =>
                handleChange("pushNotification.provider", value)
              }
            />
          </ConfigField>
          <ConfigField
            label="Server URL"
            fieldPath="pushNotification.serverUrl"
            isDefault={isDefault("pushNotification.serverUrl")}
            isModified={isModified("pushNotification.serverUrl")}
          >
            <input
              className="form-input"
              type="text"
              value={formState.pushNotification?.serverUrl ?? ""}
              onChange={(e) =>
                handleChange("pushNotification.serverUrl", e.target.value)
              }
              placeholder="https://ntfy.sh"
            />
          </ConfigField>
          <ConfigField
            label="Topic"
            fieldPath="pushNotification.topic"
            isDefault={isDefault("pushNotification.topic")}
            isModified={isModified("pushNotification.topic")}
            hint="A long random string keeps your notification stream private."
          >
            <input
              className="form-input"
              type="text"
              value={formState.pushNotification?.topic ?? ""}
              onChange={(e) =>
                handleChange("pushNotification.topic", e.target.value)
              }
            />
          </ConfigField>
        </SettingsSubSection>
        <SettingsSubSection
          title="Triggers"
          hint="Each event maps to a notification. Disable individually."
        >
          {(
            [
              "jobCompleted",
              "waitingForInput",
              "workflowCompleted",
              "workflowHalted",
              "conversationIdle",
            ] as const
          ).map((trigger) => (
            <ConfigField
              key={trigger}
              label={formatFieldLabel(trigger)}
              fieldPath={`pushNotification.triggers.${trigger}`}
              isDefault={isDefault(`pushNotification.triggers.${trigger}`)}
              isModified={isModified(`pushNotification.triggers.${trigger}`)}
            >
              <ConfigToggle
                value={formState.pushNotification?.triggers?.[trigger] ?? true}
                onChange={(value) =>
                  handleChange(`pushNotification.triggers.${trigger}`, value)
                }
              />
            </ConfigField>
          ))}
        </SettingsSubSection>
      </SettingsPage>
    );
  };

  const contentIsCapabilities = activeSection === "capabilities";

  return (
    <div className="app" data-page="config">
      <Topbar breadcrumbs={[{ label: "config" }]} page="projects" />
      <main className="main">
        <div className="config-shell" data-active-section={activeSection}>
          <aside className="config-shell__side">
            <nav className="config-shell__nav" aria-label="Settings">
              {CONFIG_NAV.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="tab"
                  aria-selected={activeSection === item.id}
                  className={
                    activeSection === item.id
                      ? "config-shell__nav-item active"
                      : "config-shell__nav-item"
                  }
                  onClick={() => setActiveSection(item.id)}
                >
                  <span>{item.label}</span>
                  {item.id === "capabilities" ? (
                    <span className="config-shell__nav-badge">cascading</span>
                  ) : null}
                </button>
              ))}
            </nav>
          </aside>
          <div
            className={`config-shell__content${contentIsCapabilities ? " config-shell__content--capabilities" : ""}`}
          >
            <div className="config-shell__scroll">{renderConfigContent()}</div>
            {!contentIsCapabilities ? (
              <ConfigSaveBar
                dirtyCount={dirtyCount}
                saving={mutation.isPending}
                onRevert={handleRevert}
                onSave={handleSave}
              />
            ) : null}
          </div>
        </div>
      </main>
    </div>
  );
}

function SettingsPage({
  title,
  accent,
  sub,
  children,
}: {
  title: string;
  accent: string;
  sub: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="config-settings-page">
      <header className="config-settings-page__head">
        <h1 className="config-settings-page__title">
          {title} <span>{accent}</span>
        </h1>
        <p className="config-settings-page__subtitle">{sub}</p>
      </header>
      <div className="config-settings-page__body">{children}</div>
    </section>
  );
}

function SettingsSubSection({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="config-section">
      <div className="config-section-header">{title}</div>
      {hint ? <div className="config-section-hint">{hint}</div> : null}
      <div className="config-section-body">{children}</div>
    </section>
  );
}

function ConfigSaveBar({
  dirtyCount,
  saving,
  onRevert,
  onSave,
}: {
  dirtyCount: number;
  saving: boolean;
  onRevert(): void;
  onSave(): void;
}): React.JSX.Element {
  return (
    <div className="config-save-bar">
      <div
        className={
          dirtyCount > 0
            ? "config-save-bar-status"
            : "config-save-bar-status config-save-bar-status--clean"
        }
      >
        <span className="config-save-bar-dot" />
        {dirtyCount > 0 ? (
          <>
            <span className="config-save-bar-count">{dirtyCount}</span> unsaved{" "}
            {dirtyCount === 1 ? "change" : "changes"}
          </>
        ) : (
          "All changes saved"
        )}
      </div>
      <div className="config-save-bar-actions">
        <button
          className="btn btn-ghost btn-sm"
          disabled={dirtyCount === 0 || saving}
          onClick={onRevert}
          type="button"
        >
          Revert
        </button>
        <button
          className="btn btn-primary btn-sm"
          disabled={dirtyCount === 0 || saving}
          onClick={onSave}
          type="button"
        >
          {saving ? "Saving..." : "Save changes"}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workflow Defaults Sub-sections
// ---------------------------------------------------------------------------

function ConfigSubsection({
  title,
  id,
  isDefault,
  children,
}: {
  title: string;
  id: string;
  isDefault: boolean;
  children: React.ReactNode;
}) {
  const cls = [
    "config-subsection",
    isDefault ? "config-subsection--default" : "config-subsection--modified",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={cls} data-subsection={id}>
      <div className="config-subsection-header">
        <span>{title}</span>
        <span className="config-subsection-badge">
          {isDefault ? "DEFAULT" : "MODIFIED"}
        </span>
      </div>
      <div className="config-subsection-body">{children}</div>
    </div>
  );
}

function WorkflowDefaultsSubsections({
  defaults,
  onChangeBlock,
}: {
  defaults: WorkflowDefaults | undefined;
  onChangeBlock: <K extends WorkflowDefaultsBlock>(
    block: K,
    value: WorkflowDefaults[K],
  ) => void;
}) {
  const effective: WorkflowDefaults = defaults ?? SEEDED_WORKFLOW_DEFAULTS;

  const implementerIsDefault = deepEqual(
    effective.implementer,
    SEEDED_WORKFLOW_DEFAULTS.implementer,
  );
  const validatorIsDefault = deepEqual(
    effective.contextValidator,
    SEEDED_WORKFLOW_DEFAULTS.contextValidator,
  );
  const scriptValidatorIsDefault = deepEqual(
    effective.scriptValidator,
    SEEDED_WORKFLOW_DEFAULTS.scriptValidator,
  );
  const iterationIsDefault = deepEqual(
    effective.iterationPolicy,
    SEEDED_WORKFLOW_DEFAULTS.iterationPolicy,
  );
  const circuitIsDefault = deepEqual(
    effective.circuitBreaker,
    SEEDED_WORKFLOW_DEFAULTS.circuitBreaker,
  );
  const mutabilityIsDefault = deepEqual(
    effective.mutability,
    SEEDED_WORKFLOW_DEFAULTS.mutability,
  );

  return (
    <>
      <ConfigSubsection
        id="implementer"
        title="Implementer"
        isDefault={implementerIsDefault}
      >
        <ImplementerFields
          value={effective.implementer}
          onChange={(v) => onChangeBlock("implementer", v)}
        />
      </ConfigSubsection>

      <ConfigSubsection
        id="contextValidator"
        title="Context validator"
        isDefault={validatorIsDefault}
      >
        <ContextValidatorFields
          value={effective.contextValidator}
          onChange={(v) => onChangeBlock("contextValidator", v)}
        />
      </ConfigSubsection>

      <ConfigSubsection
        id="scriptValidator"
        title="Script validator"
        isDefault={scriptValidatorIsDefault}
      >
        <ScriptValidatorFields
          value={effective.scriptValidator}
          onChange={(v) => onChangeBlock("scriptValidator", v)}
        />
      </ConfigSubsection>

      <ConfigSubsection
        id="iterationPolicy"
        title="Iteration policy"
        isDefault={iterationIsDefault}
      >
        <IterationPolicyFields
          value={effective.iterationPolicy}
          onChange={(v) => onChangeBlock("iterationPolicy", v)}
        />
      </ConfigSubsection>

      <ConfigSubsection
        id="circuitBreaker"
        title="Circuit breaker"
        isDefault={circuitIsDefault}
      >
        <CircuitBreakerFields
          value={effective.circuitBreaker}
          onChange={(v) => onChangeBlock("circuitBreaker", v)}
        />
      </ConfigSubsection>

      <ConfigSubsection
        id="mutability"
        title="Mutability"
        isDefault={mutabilityIsDefault}
      >
        <MutabilityFields
          value={effective.mutability}
          onChange={(v) => onChangeBlock("mutability", v)}
        />
      </ConfigSubsection>
    </>
  );
}

function ImplementerFields({
  value,
  onChange,
}: {
  value: GraphWorkflowAgentConfig;
  onChange: (v: GraphWorkflowAgentConfig) => void;
}) {
  const backend = value.backend;
  const effortOptions = getEffortOptionsForBackend(backend, value.model);

  const handleBackendChange = (next: AgentBackendId) => {
    if (next === value.backend) return;
    if (next === "codex") {
      onChange({
        backend: "codex",
        model: "gpt-5.4",
        reasoningEffort: "medium",
      });
    } else {
      onChange({
        backend: "claude",
        model: "opus",
        reasoningEffort: "medium",
      });
    }
  };

  return (
    <>
      <ConfigField
        label="Backend"
        fieldPath="workflowDefaults.implementer.backend"
        isDefault={false}
        isModified={false}
      >
        <ConfigPillGroup
          value={backend}
          options={["claude", "codex"] as const}
          onChange={handleBackendChange}
        />
      </ConfigField>

      <ConfigField
        label="Model"
        fieldPath="workflowDefaults.implementer.model"
        isDefault={false}
        isModified={false}
      >
        <ModelSelector
          value={value.model}
          backend={backend}
          onChange={(model) => {
            if (backend === "codex") {
              onChange({
                backend: "codex",
                model: model as GraphWorkflowAgentConfig["model"],
                reasoningEffort: value.reasoningEffort,
              } as GraphWorkflowAgentConfig);
            } else {
              onChange({
                backend: "claude",
                model: model as "opus" | "sonnet" | "haiku",
                reasoningEffort: value.reasoningEffort as EffortLevel,
              });
            }
          }}
        />
      </ConfigField>

      <ConfigField
        label="Reasoning effort"
        fieldPath="workflowDefaults.implementer.reasoningEffort"
        isDefault={false}
        isModified={false}
      >
        <ReasoningLevelSelector
          value={value.reasoningEffort as EffortLevel}
          availableLevels={effortOptions}
          onChange={(level) =>
            onChange({
              ...value,
              reasoningEffort: level,
            } as GraphWorkflowAgentConfig)
          }
        />
      </ConfigField>
    </>
  );
}

function ContextValidatorFields({
  value,
  onChange,
}: {
  value: GraphWorkflowAgentValidatorConfig;
  onChange: (v: GraphWorkflowAgentValidatorConfig) => void;
}) {
  const type = value.type;
  const continuityEnabled = value.continuity?.enabled ?? true;
  const continuityLimit = value.continuity?.contextLimitTokens;

  const handleTypeChange = (next: "claude" | "codex") => {
    if (next === value.type) return;
    if (next === "codex") {
      onChange({
        type: "codex",
        enabled: value.enabled,
        continuity: value.continuity ?? { enabled: true },
        codex: { model: "gpt-5.4", reasoningEffort: "medium" },
      });
    } else {
      onChange({
        type: "claude",
        enabled: value.enabled,
        continuity: value.continuity ?? { enabled: true },
        agent: {
          backend: "claude",
          model: "sonnet",
          reasoningEffort: "medium",
        },
      });
    }
  };

  return (
    <>
      <ConfigField
        label="Type"
        fieldPath="workflowDefaults.contextValidator.type"
        isDefault={false}
        isModified={false}
      >
        <ConfigPillGroup
          value={type}
          options={["claude", "codex"] as const}
          onChange={handleTypeChange}
        />
      </ConfigField>

      <ConfigField
        label="Enabled"
        fieldPath="workflowDefaults.contextValidator.enabled"
        isDefault={false}
        isModified={false}
      >
        <ConfigToggle
          value={value.enabled}
          onChange={(v) => onChange({ ...value, enabled: v })}
        />
      </ConfigField>

      {value.type === "claude" && value.agent.backend === "claude" && (
        <ClaudeAgentSubfields
          agent={value.agent}
          onAgentChange={(agent) =>
            onChange({
              type: "claude",
              enabled: value.enabled,
              continuity: value.continuity,
              agent,
            })
          }
        />
      )}

      {value.type === "codex" && (
        <CodexAgentSubfields
          model={value.codex.model}
          reasoningEffort={value.codex.reasoningEffort}
          onCodexChange={(codex) =>
            onChange({
              type: "codex",
              enabled: value.enabled,
              continuity: value.continuity,
              codex,
            })
          }
        />
      )}

      <ConfigField
        label="Continuity"
        fieldPath="workflowDefaults.contextValidator.continuity.enabled"
        isDefault={false}
        isModified={false}
      >
        <ConfigToggle
          value={continuityEnabled}
          onChange={(v) =>
            onChange({
              ...value,
              continuity: {
                enabled: v,
                ...(continuityLimit !== undefined
                  ? { contextLimitTokens: continuityLimit }
                  : {}),
              },
            })
          }
        />
      </ConfigField>

      <ConfigField
        label="Context limit tokens"
        fieldPath="workflowDefaults.contextValidator.continuity.contextLimitTokens"
        isDefault={false}
        isModified={false}
        hint="Leave empty for auto"
      >
        <ConfigNumericInput
          value={continuityLimit}
          onChange={(v) =>
            onChange({
              ...value,
              continuity: {
                enabled: continuityEnabled,
                ...(v !== undefined && v !== null
                  ? { contextLimitTokens: v }
                  : {}),
              },
            })
          }
          positive
          integer
        />
      </ConfigField>
    </>
  );
}

function ScriptValidatorFields({
  value,
  onChange,
}: {
  value: GraphWorkflowScriptValidatorConfig;
  onChange: (v: GraphWorkflowScriptValidatorConfig) => void;
}) {
  return (
    <ConfigField
      label="Enabled"
      fieldPath="workflowDefaults.scriptValidator.enabled"
      isDefault={false}
      isModified={false}
      hint="Run the project's preMergeCommand before agent validation."
    >
      <ConfigToggle
        value={value.enabled}
        onChange={(enabled) => onChange({ enabled })}
      />
    </ConfigField>
  );
}

function ClaudeAgentSubfields({
  agent,
  onAgentChange,
}: {
  agent: {
    backend: "claude";
    model: ClaudeModel;
    reasoningEffort: EffortLevel;
  };
  onAgentChange: (agent: {
    backend: "claude";
    model: ClaudeModel;
    reasoningEffort: EffortLevel;
  }) => void;
}) {
  return (
    <>
      <ConfigField
        label="Agent model"
        fieldPath="workflowDefaults.contextValidator.agent.model"
        isDefault={false}
        isModified={false}
      >
        <ModelSelector
          value={agent.model}
          backend="claude"
          onChange={(model) =>
            onAgentChange({
              backend: "claude",
              model: model as ClaudeModel,
              reasoningEffort: agent.reasoningEffort,
            })
          }
        />
      </ConfigField>
      <ConfigField
        label="Agent effort"
        fieldPath="workflowDefaults.contextValidator.agent.reasoningEffort"
        isDefault={false}
        isModified={false}
      >
        <ReasoningLevelSelector
          value={agent.reasoningEffort}
          availableLevels={getEffortOptionsForBackend("claude", agent.model)}
          onChange={(level) =>
            onAgentChange({
              backend: "claude",
              model: agent.model,
              reasoningEffort: level,
            })
          }
        />
      </ConfigField>
    </>
  );
}

function CodexAgentSubfields({
  model,
  reasoningEffort,
  onCodexChange,
}: {
  model: CodexModel | undefined;
  reasoningEffort: CodexReasoningEffort | undefined;
  onCodexChange: (codex: {
    model?: CodexModel;
    reasoningEffort?: CodexReasoningEffort;
  }) => void;
}) {
  const effectiveModel = (model ?? "gpt-5.4") as CodexModel;
  const effectiveEffort = (reasoningEffort ?? "medium") as CodexReasoningEffort;
  const effortOptions = getEffortOptionsForBackend("codex", effectiveModel);

  return (
    <>
      <ConfigField
        label="Codex model"
        fieldPath="workflowDefaults.contextValidator.codex.model"
        isDefault={false}
        isModified={false}
      >
        <ModelSelector
          value={effectiveModel}
          backend="codex"
          onChange={(next) =>
            onCodexChange({
              model: next as CodexModel,
              reasoningEffort: effectiveEffort,
            })
          }
        />
      </ConfigField>
      <ConfigField
        label="Codex effort"
        fieldPath="workflowDefaults.contextValidator.codex.reasoningEffort"
        isDefault={false}
        isModified={false}
      >
        <ReasoningLevelSelector
          value={effectiveEffort as EffortLevel}
          availableLevels={effortOptions}
          onChange={(level) =>
            onCodexChange({
              model: effectiveModel,
              reasoningEffort: level as CodexReasoningEffort,
            })
          }
        />
      </ConfigField>
    </>
  );
}

function IterationPolicyFields({
  value,
  onChange,
}: {
  value: GraphWorkflowIterationPolicy;
  onChange: (v: GraphWorkflowIterationPolicy) => void;
}) {
  const continuityEnabled = value.continuity?.enabled ?? true;
  const continuityLimit = value.continuity?.contextLimitTokens;

  return (
    <>
      <ConfigField
        label="Max iterations"
        fieldPath="workflowDefaults.iterationPolicy.maxIterations"
        isDefault={false}
        isModified={false}
      >
        <ConfigNumericInput
          value={value.maxIterations}
          onChange={(v) =>
            onChange({
              ...value,
              maxIterations:
                typeof v === "number" && v > 0 ? v : value.maxIterations,
            })
          }
          required
          positive
          integer
        />
      </ConfigField>

      <ConfigField
        label="Continuity"
        fieldPath="workflowDefaults.iterationPolicy.continuity.enabled"
        isDefault={false}
        isModified={false}
      >
        <ConfigToggle
          value={continuityEnabled}
          onChange={(v) =>
            onChange({
              ...value,
              continuity: {
                enabled: v,
                ...(continuityLimit !== undefined
                  ? { contextLimitTokens: continuityLimit }
                  : {}),
              },
            })
          }
        />
      </ConfigField>

      <ConfigField
        label="Context limit tokens"
        fieldPath="workflowDefaults.iterationPolicy.continuity.contextLimitTokens"
        isDefault={false}
        isModified={false}
        hint="Leave empty for auto"
      >
        <ConfigNumericInput
          value={continuityLimit}
          onChange={(v) =>
            onChange({
              ...value,
              continuity: {
                enabled: continuityEnabled,
                ...(v !== undefined && v !== null
                  ? { contextLimitTokens: v }
                  : {}),
              },
            })
          }
          positive
          integer
        />
      </ConfigField>
    </>
  );
}

function CircuitBreakerFields({
  value,
  onChange,
}: {
  value: GraphWorkflowCircuitBreakerPolicy;
  onChange: (v: GraphWorkflowCircuitBreakerPolicy) => void;
}) {
  return (
    <ConfigField
      label="Failure threshold"
      fieldPath="workflowDefaults.circuitBreaker.consecutiveFailureThreshold"
      isDefault={false}
      isModified={false}
      hint="Consecutive failures before the context is halted"
    >
      <ConfigNumericInput
        value={value.consecutiveFailureThreshold}
        onChange={(v) =>
          onChange({
            consecutiveFailureThreshold: typeof v === "number" ? v : undefined,
          })
        }
        positive
        integer
      />
    </ConfigField>
  );
}

function MutabilityFields({
  value,
  onChange,
}: {
  value: GraphWorkflowMutabilityPolicy;
  onChange: (v: GraphWorkflowMutabilityPolicy) => void;
}) {
  return (
    <ConfigField
      label="Allow agent task add"
      fieldPath="workflowDefaults.mutability.allowAgentTaskAdd"
      isDefault={false}
      isModified={false}
      hint="Let agents add tasks during execution"
    >
      <ConfigToggle
        value={value.allowAgentTaskAdd}
        onChange={(v) => onChange({ allowAgentTaskAdd: v })}
      />
    </ConfigField>
  );
}
