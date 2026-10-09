import type { AgentBackendId } from "@/lib/shared/schemas";

/**
 * A saved template as its editor reads it: the template-wide defaults over
 * the global ones, each context's overrides over those, and its content.
 * Every setting carries the tier its value comes from (design amendment 17).
 */

export type Tier = "global" | "template" | "context";

export interface Setting<T> {
  value: T;
  from: Tier;
}

export interface SeatConfig {
  backend: AgentBackendId;
  model: string;
  effort: string;
  profile: string;
}

export interface ReviewerConfig {
  profile: string;
  id: string;
  authority: "blocking" | "advisory";
  focus: string;
  backend: AgentBackendId;
  model: string;
  effort: string;
}

export interface ConfigBlock {
  implementer: Setting<SeatConfig>;
  reviewers: Setting<ReviewerConfig[]>;
  checks: Setting<string[]>;
  humanApproval: Setting<boolean>;
  ownerQuestions: Setting<boolean>;
  unfinishedTaskRetries: Setting<number>;
  validationRetries: Setting<number>;
  captureRepairLimit: Setting<number>;
  instabilityLimit: Setting<number>;
  adviceCorrectionLimit: Setting<number>;
  timeoutMinutes: Setting<number | null>;
}

export type ConfigKey = keyof ConfigBlock;

export interface TemplateContext {
  key: string;
  title: string;
  brief: string;
  tasks: Array<{ id: string; title: string; instructions: string }>;
  criteria: Array<{ id: string; text: string }>;
  /** JSON text as written; validated as it is edited. */
  outputSchema: string;
  dependsOn: string[];
  /** Dependencies that carry accepted output without needing code publication. */
  outputOnly: string[];
  /** Read-only labels for authored route guards, keyed by source context. */
  guards: Record<string, string>;
  scope: { mode: "full" | "readOnly" } | { mode: "owned"; paths: string[] };
  lane: string | null;
  loop: string | null;
  config: ConfigBlock;
}

export interface TemplateSummary {
  description: string;
  id: string;
  name: string;
  tier: "project" | "global";
  contexts: number;
  updatedAt: string;
}

export interface Template {
  id: string;
  name: string;
  tier: "project" | "global";
  revision: number;
  updatedAt: string;
  description: string;
  parameters: Array<{ name: string; description: string; required: boolean }>;
  /** The template-wide tier; its `from` is `template` or `global`. */
  defaults: ConfigBlock;
  /** The global tier, for resetting a template default. */
  globals: { [K in ConfigKey]: ConfigBlock[K]["value"] };
  contexts: TemplateContext[];
  lanes: Array<{ key: string; checks: string[] }>;
  loops: Array<{ key: string; body: string[]; maxPasses: number; until: string }>;
}

export interface CatalogOption {
  backend: AgentBackendId;
  models: string[];
  /** Supported levels from the backend model catalog, when available. */
  effortsByModel?: Record<string, string[]>;
}
