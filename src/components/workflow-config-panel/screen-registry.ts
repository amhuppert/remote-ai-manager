import type { ConfigScope } from "./types";

/**
 * The seam the two downstream screen contexts extend. A screen registers by id
 * and the panel's push navigation resolves it — so adding the Brief, Placement,
 * Tasks, Charter, Quality-gates or seat screens never edits the navigation
 * stack, the header or the back row.
 */

export interface ConfigScreenRenderContext {
  /** The full screen id being rendered, e.g. `seat:security`. */
  screenId: string;
  /** For a parametric screen, the segment after the `:` (`security`). */
  param: string;
  scope: ConfigScope;
  /** Push a child screen onto the stack. */
  navigate: (screenId: string) => void;
  /** Pop exactly one level. */
  back: () => void;
}

export interface ConfigScreenDefinition {
  /**
   * An exact id (`gates`), or a parametric prefix ending in `:` (`seat:`) that
   * matches every id beginning with it.
   */
  id: string;
  /** Uppercase screen title for the deep header. */
  title: string | ((param: string) => string);
  /** Override-count badge for this screen, e.g. `1 role set here`. */
  overrideLabel?: string | ((param: string) => string | null) | null;
  render: (context: ConfigScreenRenderContext) => React.ReactNode;
}

export interface ResolvedConfigScreen {
  definition: ConfigScreenDefinition;
  screenId: string;
  param: string;
  title: string;
  overrideLabel: string | null;
}

export interface ConfigScreenRegistry {
  resolve(screenId: string): ResolvedConfigScreen | undefined;
  /** Screen title used by a child's back row when this screen is the parent. */
  titleOf(screenId: string): string | undefined;
}

function isParametric(id: string): boolean {
  return id.endsWith(":");
}

function paramOf(screenId: string, definitionId: string): string {
  return isParametric(definitionId) ? screenId.slice(definitionId.length) : "";
}

export function createConfigScreenRegistry(
  definitions: readonly ConfigScreenDefinition[],
): ConfigScreenRegistry {
  const exact = new Map<string, ConfigScreenDefinition>();
  const parametric: ConfigScreenDefinition[] = [];
  for (const definition of definitions) {
    if (isParametric(definition.id)) parametric.push(definition);
    else exact.set(definition.id, definition);
  }

  function find(screenId: string): ConfigScreenDefinition | undefined {
    // Exact ids win: a screen may register `seat:` broadly and still pin one id.
    return (
      exact.get(screenId) ??
      parametric.find((candidate) => screenId.startsWith(candidate.id))
    );
  }

  return {
    resolve(screenId) {
      const definition = find(screenId);
      if (!definition) return undefined;
      const param = paramOf(screenId, definition.id);
      const label =
        typeof definition.overrideLabel === "function"
          ? definition.overrideLabel(param)
          : (definition.overrideLabel ?? null);
      return {
        definition,
        screenId,
        param,
        title:
          typeof definition.title === "function"
            ? definition.title(param)
            : definition.title,
        overrideLabel: label,
      };
    },
    titleOf(screenId) {
      const definition = find(screenId);
      if (!definition) return undefined;
      const param = paramOf(screenId, definition.id);
      return typeof definition.title === "function"
        ? definition.title(param)
        : definition.title;
    },
  };
}
