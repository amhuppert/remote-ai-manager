/**
 * Claude plugin enablement translator — native setting preservation.
 *
 * The installed `@anthropic-ai/claude-agent-sdk` `Settings.enabledPlugins`
 * accepts `boolean | string[] | { [k]: unknown }` keyed by `plugin-id@marketplace-id`.
 * Native config files can carry extended values (e.g. `{ version: "1.2.0" }`)
 * that the SDK uses for version pinning. Command Center owns enable/disable
 * intent only; we must never overwrite those extended values.
 *
 * Translation rules:
 *   1. If no CC override exists for a plugin, omit it from the flag-layer
 *      output entirely so the SDK keeps the native entry verbatim.
 *   2. If the CC resolved state equals the native state, omit it for the
 *      same reason — the override is a no-op.
 *   3. If the CC resolved state disagrees with the native state, emit the
 *      smallest possible flag-layer value:
 *        - disable a natively-enabled plugin with `false`
 *        - enable a natively-disabled plugin with `true`
 *      We never emit extended object values; native extended values are
 *      preserved only by omission.
 *   4. Overrides targeting plugin ids not present in native discovery are
 *      treated as stale and surfaced as diagnostics; they do not appear in
 *      the emitted output.
 *
 * The translator returns an in-memory flag-layer payload only. It performs
 * no filesystem I/O and never writes backend-owned configuration files.
 */

export interface ClaudePluginNativeRecord {
  pluginId: string;
  nativeEnabled: boolean;
  /** Raw `enabledPlugins[pluginId]` value from native settings. Kept here so
   * the translator can decide whether the override is a no-op against the
   * native shape, but never re-emitted. Adapter-private. */
  nativeRawValue?:
    | boolean
    | readonly string[]
    | { readonly [k: string]: unknown };
}

export interface ClaudePluginOverrideState {
  resolvedEnabled: boolean;
}

export interface ClaudePluginTranslationDiagnostic {
  code: "claude-plugin-override-stale";
  pluginId: string;
  message: string;
}

export interface ClaudePluginTranslationInput {
  native: readonly ClaudePluginNativeRecord[];
  overrides: ReadonlyMap<string, ClaudePluginOverrideState>;
}

export interface ClaudePluginTranslationResult {
  /** Minimal flag-layer delta to feed into `applyFlagSettings` /
   * `QuerySessionOptions.settings.enabledPlugins`. Omits any plugin whose
   * resolved state equals native; emits `true`/`false` only when CC must
   * override native. */
  enabledPlugins: Record<string, boolean>;
  diagnostics: readonly ClaudePluginTranslationDiagnostic[];
  changedPluginIds: readonly string[];
}

export function translateClaudePluginEnablement(
  input: ClaudePluginTranslationInput,
): ClaudePluginTranslationResult {
  const enabledPlugins: Record<string, boolean> = {};
  const diagnostics: ClaudePluginTranslationDiagnostic[] = [];
  const changedPluginIds: string[] = [];

  const nativeById = new Map<string, ClaudePluginNativeRecord>();
  for (const record of input.native) {
    nativeById.set(record.pluginId, record);
  }

  for (const [pluginId, override] of input.overrides) {
    const native = nativeById.get(pluginId);
    if (!native) {
      diagnostics.push({
        code: "claude-plugin-override-stale",
        pluginId,
        message: `CC override for plugin "${pluginId}" does not match any natively discovered plugin; entry omitted from emitted flag settings.`,
      });
      continue;
    }

    if (override.resolvedEnabled === native.nativeEnabled) {
      // No-op override: omit to preserve native extended value verbatim.
      continue;
    }

    enabledPlugins[pluginId] = override.resolvedEnabled;
    changedPluginIds.push(pluginId);
  }

  return { enabledPlugins, diagnostics, changedPluginIds };
}
