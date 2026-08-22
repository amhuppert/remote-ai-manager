/**
 * Cursor model policy (spec D10): the adapter is the validation authority for
 * which model a run may use. Resolution is explicit selection, then the global
 * Cursor profile, then the descriptor default — and the resolved value must be
 * a member of the project's effective supported list. A value outside the list
 * is always a bounded client error, never a substitution: silently running a
 * different model than the operator configured is worse than refusing.
 *
 * No production path here calls live model-catalog discovery, and there is no
 * Cursor speed toggle: the list is static configuration.
 */

import type { PerRepoConfig } from "@/lib/config/schemas";

export const CURSOR_DEFAULT_MODEL = "composer-2.5";

/** Effective list when a project configures none. */
export const CURSOR_DEFAULT_SUPPORTED_MODELS: readonly string[] = [
  CURSOR_DEFAULT_MODEL,
];

export type CursorModelSource = "explicit" | "global_profile" | "default";

export type CursorModelFailureCode =
  /** A selected ID (explicit or global profile) is not in the effective list. */
  | "model_not_supported"
  /** Nothing was selected and the effective list omits the default. */
  | "default_model_not_supported"
  /** The project's configuration could not be read, so no list is knowable. */
  | "supported_models_unreadable";

export type CursorModelResolution =
  | {
      ok: true;
      model: string;
      source: CursorModelSource;
      supportedModels: readonly string[];
    }
  | {
      ok: false;
      code: CursorModelFailureCode;
      message: string;
      supportedModels: readonly string[];
    };

export interface CursorModelResolutionInput {
  explicitSelection?: string | null;
  globalProfileModel?: string | null;
  /**
   * The project's configured list, or null/undefined when unconfigured. An
   * empty array is configured-and-empty: it permits nothing and fails closed,
   * rather than falling back to the default list.
   */
  configuredSupportedModels?: readonly string[] | null;
}

/** The repo-config and global-settings reads, injected. */
export interface CursorModelPolicyDeps {
  supportedModels(projectPath: string): Promise<readonly string[] | null>;
  globalProfileModel(): Promise<string | null>;
}

function selected(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The pure decision. Kept separate from the config reads so the resolution
 * order and every fail-closed edge are testable without a config fixture.
 */
export function resolveCursorModel(
  input: CursorModelResolutionInput,
): CursorModelResolution {
  const supportedModels =
    input.configuredSupportedModels ?? CURSOR_DEFAULT_SUPPORTED_MODELS;

  const explicit = selected(input.explicitSelection);
  const globalProfile = selected(input.globalProfileModel);
  const chosen = explicit ?? globalProfile;

  if (chosen === null) {
    if (!supportedModels.includes(CURSOR_DEFAULT_MODEL)) {
      return {
        ok: false,
        code: "default_model_not_supported",
        message: `No Cursor model is selected and the configured list does not include the default ${CURSOR_DEFAULT_MODEL}.`,
        supportedModels,
      };
    }
    return {
      ok: true,
      model: CURSOR_DEFAULT_MODEL,
      source: "default",
      supportedModels,
    };
  }

  if (!supportedModels.includes(chosen)) {
    return {
      ok: false,
      code: "model_not_supported",
      message: `Cursor model "${chosen}" is not in this project's supported model list.`,
      supportedModels,
    };
  }

  return {
    ok: true,
    model: chosen,
    source: explicit !== null ? "explicit" : "global_profile",
    supportedModels,
  };
}

/** Bound on the parser detail carried into a refusal message. */
const UNREADABLE_REASON_MAX_LENGTH = 200;

export async function resolveCursorModelForProject(
  input: { projectPath: string; explicitSelection?: string | null },
  deps: CursorModelPolicyDeps,
): Promise<CursorModelResolution> {
  let configuredSupportedModels: readonly string[] | null;
  let globalProfileModel: string | null;
  try {
    [configuredSupportedModels, globalProfileModel] = await Promise.all([
      deps.supportedModels(input.projectPath),
      deps.globalProfileModel(),
    ]);
  } catch (err) {
    // A configuration Command Center cannot parse leaves the effective list
    // unknown, and guessing one would be the substitution this policy exists to
    // prevent. Bounded refusal instead of a thrown error, so the caller settles
    // the turn the same way it settles an unsupported model.
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      code: "supported_models_unreadable",
      message: `Could not read this project's Cursor supported-model list from CommandCenter.json: ${reason.slice(0, UNREADABLE_REASON_MAX_LENGTH)}`,
      supportedModels: [],
    };
  }

  return resolveCursorModel({
    explicitSelection: input.explicitSelection,
    globalProfileModel,
    configuredSupportedModels,
  });
}

/**
 * Bind the policy's supported-list read to the project's `CommandCenter.json`
 * through the repo-config reader, which parses it with the canonical per-repo
 * schema. Null means the project declares no list; a declared-empty list is
 * reported as configured-and-empty, which permits nothing.
 */
export function createCursorSupportedModelsReader(
  readRepoConfig: (projectPath: string) => Promise<PerRepoConfig | null>,
): CursorModelPolicyDeps["supportedModels"] {
  return async (projectPath: string) => {
    const config = await readRepoConfig(projectPath);
    return config?.agentBackends?.cursor?.supportedModels ?? null;
  };
}
