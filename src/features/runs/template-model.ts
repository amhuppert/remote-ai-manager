/**
 * The run template editor's model. The draft is the template's authored
 * content: its `defaults` patch and each context's `settings` patch, exactly
 * as stored. Every value the editor shows comes from the configuration
 * cascade (`cascadeSettings`) with the tier it came from; an edit writes one
 * patch, a reset deletes the key from it, and unsaved changes compare the
 * patches. Displaying, refreshing, resetting and editing another setting
 * never write an untouched setting into a nearer tier; editing a setting
 * authors it whole there (the implementer seat or the reviewer list as one
 * value), as the cascade replaces it whole.
 *
 * Problems that block a save are the server's own validation
 * (`validateRunTemplate`), located at the part of the editor that holds them.
 */
import {
  cascadeSettings,
  type CascadedSettings,
} from "@/lib/config/settings-cascade";
import {
  validateRunTemplate,
  type RunTemplateContent,
  type RunTemplateContext,
  type RunTemplateRecord,
} from "@/lib/run-templates/document";
import {
  RUN_SETTING_KEYS,
  type RunSettingKey,
  type RunSettings,
  type RunSettingsPatch,
} from "@/lib/runs/settings";
import { deepEqualJson } from "@/lib/shared/deep-equal";

/** The editor part holding the template's details, defaults and lane checks; a context key names any other part. */
export const TEMPLATE_PART = "#template";

/** What a save sends: the record without the identity and revision storage owns. */
export function contentOf(record: RunTemplateRecord): RunTemplateContent {
  return {
    name: record.name,
    description: record.description,
    parameters: record.parameters,
    defaults: record.defaults,
    workflow: record.workflow,
  };
}

/** The template tier: what every context inherits. */
export function templateSettings(
  globals: RunSettings,
  draft: RunTemplateContent,
): CascadedSettings<RunSettings> {
  return cascadeSettings<RunSettings>({
    global: globals,
    template: draft.defaults,
  });
}

/** One context's settings: its own overrides over the template tier. */
export function contextSettings(
  globals: RunSettings,
  draft: RunTemplateContent,
  contextKey: string,
): CascadedSettings<RunSettings> {
  const settings = draft.workflow.contexts.find(
    (context) => context.key === contextKey,
  )?.settings;
  return cascadeSettings<RunSettings>({
    global: globals,
    template: draft.defaults,
    ...(settings === undefined ? {} : { context: settings }),
  });
}

function withSetting<K extends RunSettingKey>(
  patch: RunSettingsPatch,
  key: K,
  value: RunSettings[K],
): RunSettingsPatch {
  const next: RunSettingsPatch = { ...patch };
  next[key] = value;
  return next;
}

function withoutSetting(
  patch: RunSettingsPatch,
  key: RunSettingKey,
): RunSettingsPatch {
  const next: RunSettingsPatch = { ...patch };
  delete next[key];
  return next;
}

function updateContext(
  draft: RunTemplateContent,
  contextKey: string,
  change: (context: RunTemplateContext) => RunTemplateContext,
): RunTemplateContent {
  return {
    ...draft,
    workflow: {
      ...draft.workflow,
      contexts: draft.workflow.contexts.map((context) =>
        context.key === contextKey ? change(context) : context,
      ),
    },
  };
}

/** A context with these settings; one that sets nothing carries no `settings`. */
function withContextSettings(
  context: RunTemplateContext,
  settings: RunSettingsPatch,
): RunTemplateContext {
  const next: RunTemplateContext = { ...context, settings };
  if (Object.keys(settings).length === 0) delete next.settings;
  return next;
}

export function setDefault<K extends RunSettingKey>(
  draft: RunTemplateContent,
  key: K,
  value: RunSettings[K],
): RunTemplateContent {
  return { ...draft, defaults: withSetting(draft.defaults, key, value) };
}

export function resetDefault(
  draft: RunTemplateContent,
  key: RunSettingKey,
): RunTemplateContent {
  return { ...draft, defaults: withoutSetting(draft.defaults, key) };
}

export function setContextSetting<K extends RunSettingKey>(
  draft: RunTemplateContent,
  contextKey: string,
  key: K,
  value: RunSettings[K],
): RunTemplateContent {
  return updateContext(draft, contextKey, (context) =>
    withContextSettings(
      context,
      withSetting(context.settings ?? {}, key, value),
    ),
  );
}

export function resetContextSetting(
  draft: RunTemplateContent,
  contextKey: string,
  key: RunSettingKey,
): RunTemplateContent {
  return updateContext(draft, contextKey, (context) =>
    withContextSettings(context, withoutSetting(context.settings ?? {}, key)),
  );
}

/** A change to a context's content; empty optional text and empty lists are left out of the document. */
export interface ContextContentChange {
  title?: string;
  brief?: string;
  tasks?: ReadonlyArray<{ title: string; instructions: string }>;
  acceptanceCriteria?: readonly string[];
  /** Null removes the schema: the accepted output is then the implementer's closing summary. */
  outputSchema?: Record<string, unknown> | null;
}

export function editContext(
  draft: RunTemplateContent,
  contextKey: string,
  change: ContextContentChange,
): RunTemplateContent {
  return updateContext(draft, contextKey, (context) => {
    const next: RunTemplateContext = { ...context };
    if (change.brief !== undefined) next.brief = change.brief;
    if (change.title !== undefined) {
      if (change.title.trim() === "") delete next.title;
      else next.title = change.title;
    }
    if (change.tasks !== undefined) {
      if (change.tasks.length === 0) delete next.tasks;
      else
        next.tasks = change.tasks.map(({ title, instructions }) =>
          instructions.trim() === "" ? { title } : { title, instructions },
        );
    }
    if (change.acceptanceCriteria !== undefined) {
      if (change.acceptanceCriteria.length === 0)
        delete next.acceptanceCriteria;
      else next.acceptanceCriteria = [...change.acceptanceCriteria];
    }
    if (change.outputSchema !== undefined) {
      if (change.outputSchema === null) delete next.outputSchema;
      else next.outputSchema = change.outputSchema;
    }
    return next;
  });
}

/** A lane's publication checks; a lane with none carries no `checks`. */
export function setLaneChecks(
  draft: RunTemplateContent,
  laneKey: string,
  checks: readonly string[],
): RunTemplateContent {
  return {
    ...draft,
    workflow: {
      ...draft.workflow,
      lanes: draft.workflow.lanes?.map((lane) =>
        lane.key !== laneKey
          ? lane
          : checks.length === 0
            ? { key: lane.key }
            : { key: lane.key, checks: [...checks] },
      ),
    },
  };
}

const TEMPLATE_FIELDS = ["name", "description", "parameters"] as const;
const CONTEXT_FIELDS = [
  "title",
  "brief",
  "tasks",
  "acceptanceCriteria",
  "outputSchema",
] as const;

function differingSettings(
  saved: RunSettingsPatch | undefined,
  draft: RunSettingsPatch | undefined,
): number {
  return RUN_SETTING_KEYS.filter(
    (key) => !deepEqualJson(saved?.[key], draft?.[key]),
  ).length;
}

/**
 * How many fields differ from the saved content, by part. Settings compare
 * as authored patches: an inherited value is never a change, and setting a
 * key then resetting it leaves none.
 */
export function changeCounts(
  saved: RunTemplateContent,
  draft: RunTemplateContent,
): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  const add = (part: string, count: number) => {
    if (count > 0) counts.set(part, (counts.get(part) ?? 0) + count);
  };
  add(
    TEMPLATE_PART,
    TEMPLATE_FIELDS.filter(
      (field) => !deepEqualJson(saved[field], draft[field]),
    ).length +
      differingSettings(saved.defaults, draft.defaults) +
      (draft.workflow.lanes ?? []).filter(
        (lane) =>
          !deepEqualJson(
            saved.workflow.lanes?.find((other) => other.key === lane.key),
            lane,
          ),
      ).length,
  );
  for (const context of draft.workflow.contexts) {
    const before = saved.workflow.contexts.find(
      (other) => other.key === context.key,
    );
    if (before === undefined) continue;
    add(
      context.key,
      CONTEXT_FIELDS.filter(
        (field) => !deepEqualJson(before[field], context[field]),
      ).length + differingSettings(before.settings, context.settings),
    );
  }
  return counts;
}

/** A problem that blocks a save: the editor part it belongs to, where in that part, and why. */
export interface DraftProblem {
  part: string;
  location: string;
  message: string;
}

/**
 * The server's validation of the draft, each problem located at its part: a
 * problem inside a context at that context, anything else at the template.
 */
export function draftProblems(draft: RunTemplateContent): DraftProblem[] {
  const validated = validateRunTemplate(draft);
  if (validated.ok) return [];
  return validated.issues.map(({ path, message }) => {
    const [root, collection, index, ...rest] = path.split(".");
    const context =
      root === "workflow" && collection === "contexts"
        ? draft.workflow.contexts[Number(index)]
        : undefined;
    if (context === undefined)
      return { part: TEMPLATE_PART, location: path, message };
    return {
      part: context.key,
      location: [context.key, rest.join(".")]
        .filter((segment) => segment !== "")
        .join(" · "),
      message,
    };
  });
}

const MINUTE_MS = 60_000;

/** The per-invocation time limit as the editor shows it; null is no limit. */
export function minutesOf(timeoutMs: number | null): number | null {
  return timeoutMs === null ? null : timeoutMs / MINUTE_MS;
}

export function timeoutMsOf(minutes: number | null): number | null {
  return minutes === null ? null : minutes * MINUTE_MS;
}
