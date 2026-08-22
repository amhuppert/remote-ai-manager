/**
 * The config panel is mounted by two pages with different powers over the same
 * configuration, so its host, scope and affordance are inputs rather than
 * inferred state (design README §8).
 */

import type { ExecutionEditability } from "@/lib/workflow-graph/lifecycle-classifier";

/** Which page mounted the panel. */
export type ConfigPanelHost = "builder" | "execution";

/** Which tier the panel is editing. The execution host is context-only. */
export type ConfigScope = "workflow" | "context";

/** What the mounting page permits right now (README §8.1). */
export type ConfigAffordance =
  | "editable"
  | "pause-to-edit"
  | "frozen"
  | "read-only";

/**
 * Why a read-only execution cannot be edited (README §8.1). Derived from the
 * classifier so a new not-editable reason fails to compile here until the panel
 * says what it means to an author.
 */
export type ConfigReadOnlyReason = Extract<
  ExecutionEditability,
  { kind: "not-editable" }
>["reason"];

/** The save bar's six states (README §8.2). */
export type ConfigSaveState =
  | "clean"
  | "dirty"
  | "saving"
  | "saved"
  | "conflict"
  | "error";

/** The cascade's three tiers (README §7). */
export type ConfigTier = "global" | "workflow" | "context";

/**
 * The granularity an override is stored and reset at. Editing one role or one
 * field never promotes its siblings, so the reset affordance has to name which
 * of the three it clears.
 */
export type ConfigGranularity = "block" | "role" | "field";
