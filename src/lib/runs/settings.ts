/**
 * The run setting vocabulary and the global tier (design §2.4, §7.2).
 *
 * A setting is what the configuration cascade decides per context: who staffs
 * the implementer and reviewer seats, which checks run, whether a person
 * approves, whether seats may ask the owner, and the per-invocation timeout.
 * Each is replaced whole by the nearest tier that sets it
 * (`config/settings-cascade.ts`); a template stores only the keys it sets.
 *
 * `RUN_SETTING_DEFAULTS` is the global tier and the single owner of the
 * resolver's defaults: `resolveContextStart` reads it for every field a launch
 * leaves out. Its implementer names a profile but no backend or model, which
 * means the configured default backend and its default model, resolved at
 * launch exactly as for a launch that names neither; it never pins today's
 * configuration.
 *
 * Browser-safe: it imports schema modules only.
 */
import { z } from "zod";
import type {
  CascadedSettings,
  ProvenancedSetting,
} from "@/lib/config/settings-cascade";
import { STANDARD_AGENT_PROFILE_ID } from "@/lib/agent-profiles/builtins";
import {
  agentProfileRefSchema,
  type AgentProfileRef,
} from "@/lib/agent-profiles/schemas";
import {
  backendModelSelectionSchema,
  type BackendModelSelection,
} from "@/lib/agent-backends/schemas";
import { reviewerAuthoritySchema } from "@/lib/execution-context/schemas";
import { validationCommandNameSchema } from "@/lib/validation/schemas";
import { agentBackendSchema, type AgentBackendId } from "@/lib/shared/schemas";

/** The implementer seat, replaced as one unit. An absent backend or model means the configured default. */
export const implementerSettingSchema = z
  .object({
    profile: agentProfileRefSchema,
    backend: agentBackendSchema.optional(),
    modelSelection: backendModelSelectionSchema.optional(),
  })
  .strict();
export type ImplementerSetting = z.infer<typeof implementerSettingSchema>;

/** One reviewer seat; the reviewer list is replaced as one unit. */
export const reviewerSettingSchema = z
  .object({
    authority: reviewerAuthoritySchema,
    focus: z.string().trim().min(1).optional(),
    profile: agentProfileRefSchema,
    backend: agentBackendSchema.optional(),
    modelSelection: backendModelSelectionSchema.optional(),
  })
  .strict();
export type ReviewerSetting = z.infer<typeof reviewerSettingSchema>;

export const runSettingsSchema = z
  .object({
    implementer: implementerSettingSchema,
    reviewers: z.array(reviewerSettingSchema),
    checks: z.array(validationCommandNameSchema),
    humanApproval: z.boolean(),
    ownerQuestions: z.boolean(),
    /** A limit per backend invocation; null for none. */
    timeoutMs: z.number().int().positive().nullable(),
  })
  .strict();
export type RunSettings = z.infer<typeof runSettingsSchema>;

/** The keys one tier sets; an absent key falls through to the next tier. */
export const runSettingsPatchSchema = runSettingsSchema.partial().strict();
export type RunSettingsPatch = z.infer<typeof runSettingsPatchSchema>;
export type RunSettingKey = keyof RunSettings;

export const DEFAULT_IMPLEMENTER_PROFILE: AgentProfileRef = {
  tier: "builtin",
  id: STANDARD_AGENT_PROFILE_ID,
};
/** The profile a reviewer a launch adds without one runs under. */
export const DEFAULT_REVIEWER_PROFILE: AgentProfileRef = {
  tier: "builtin",
  id: "general-reviewer",
};

/** The global tier: what a launch gets for every setting no nearer tier sets. */
export const RUN_SETTING_DEFAULTS: RunSettings = {
  implementer: { profile: DEFAULT_IMPLEMENTER_PROFILE },
  reviewers: [],
  checks: [],
  humanApproval: false,
  ownerQuestions: true,
  timeoutMs: null,
};

/** The launch request fields settings map to; each is optional, as in `cctl run launch`. */
export interface RunSettingsRequestFields {
  profile?: AgentProfileRef;
  backend?: AgentBackendId;
  modelSelection?: BackendModelSelection;
  reviewers?: ReviewerSetting[];
  checks?: string[];
  humanApproval?: boolean;
  ownerQuestions?: boolean;
  timeoutMs?: number;
}

/** Every launch request field a setting owns, as a mask; a template context may not carry them. */
export const SETTING_REQUEST_FIELD_MASK = {
  profile: true,
  backend: true,
  modelSelection: true,
  reviewers: true,
  checks: true,
  humanApproval: true,
  ownerQuestions: true,
  timeoutMs: true,
} as const satisfies Record<keyof RunSettingsRequestFields, true>;

export function isSettingRequestField(field: string): boolean {
  return Object.hasOwn(SETTING_REQUEST_FIELD_MASK, field);
}

/**
 * The launch request fields for the settings a patch sets, and only those: a
 * key the patch leaves out stays out of the request, so the resolver supplies
 * the global tier exactly as it does for a launch that omits it.
 */
export function requestFieldsOf(
  patch: RunSettingsPatch,
): RunSettingsRequestFields {
  const {
    implementer,
    reviewers,
    checks,
    humanApproval,
    ownerQuestions,
    timeoutMs,
  } = patch;
  return {
    ...(implementer === undefined ? {} : implementer),
    ...(reviewers === undefined ? {} : { reviewers }),
    ...(checks === undefined ? {} : { checks }),
    ...(humanApproval === undefined ? {} : { humanApproval }),
    ...(ownerQuestions === undefined ? {} : { ownerQuestions }),
    // A null timeout is the global tier's "none", which a launch spells by leaving it out.
    ...(timeoutMs === undefined || timeoutMs === null ? {} : { timeoutMs }),
  };
}

/** Every setting key, in the order a form lists them. */
export const RUN_SETTING_KEYS = [
  "implementer",
  "reviewers",
  "checks",
  "humanApproval",
  "ownerQuestions",
  "timeoutMs",
] as const satisfies readonly RunSettingKey[];
const everySettingKeyListed: Exclude<
  RunSettingKey,
  (typeof RUN_SETTING_KEYS)[number]
> extends never
  ? true
  : never = true;
void everySettingKeyListed;

function setAbove<T>(setting: ProvenancedSetting<T>): T | undefined {
  return setting.from === "global" ? undefined : setting.value;
}

/**
 * The settings a cascade took from a template or a context; a global-tier
 * setting is left undefined, so a launch request built from them leaves it to
 * the resolver.
 */
export function settingsSetAbove(
  cascaded: CascadedSettings<RunSettings>,
): RunSettingsPatch {
  return {
    implementer: setAbove(cascaded.implementer),
    reviewers: setAbove(cascaded.reviewers),
    checks: setAbove(cascaded.checks),
    humanApproval: setAbove(cascaded.humanApproval),
    ownerQuestions: setAbove(cascaded.ownerQuestions),
    timeoutMs: setAbove(cascaded.timeoutMs),
  } satisfies Record<RunSettingKey, unknown>;
}

const IMPLEMENTER_REQUEST_FIELDS: ReadonlySet<string> = new Set([
  "profile",
  "backend",
  "modelSelection",
]);
/** Settings whose launch field has the setting's own name. */
const DIRECT_SETTING_KEYS: ReadonlySet<string> = new Set<string>(
  RUN_SETTING_KEYS.filter((key) => key !== "implementer"),
);

function isDirectSettingKey(field: string): field is RunSettingKey {
  return DIRECT_SETTING_KEYS.has(field);
}

/**
 * Where an issue a launch request reports at `path` (relative to one
 * context's request) lives among that context's settings; null when the field
 * is not a setting's.
 */
export function settingPathOf(
  path: ReadonlyArray<string | number>,
): { key: RunSettingKey; path: Array<string | number> } | null {
  const [field] = path;
  if (typeof field !== "string") return null;
  if (IMPLEMENTER_REQUEST_FIELDS.has(field))
    return { key: "implementer", path: ["implementer", ...path] };
  if (isDirectSettingKey(field)) return { key: field, path: [...path] };
  return null;
}
