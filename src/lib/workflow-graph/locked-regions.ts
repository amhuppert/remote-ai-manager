import { isDeepStrictEqual } from "node:util";
import type {
  ResolvedWorkflowSemanticDefinition,
  WorkflowLockedRegion,
  WorkflowSemanticDefinition,
} from "./definition-schemas";

export type DefinitionPath = readonly string[];

type LockableDefinition =
  | WorkflowSemanticDefinition
  | ResolvedWorkflowSemanticDefinition;

export interface LockedRegionMatch extends WorkflowLockedRegion {
  lockedPath: string;
}

/**
 * The regions a managed definition's server stamps and a submitted plan may
 * omit: provenance, approval policy, and the lock table itself. Kept as the
 * JSON-pointer paths a refusal names, with the object keys derived from them,
 * so the merge and the refusal cannot disagree about which fields these are.
 */
const SERVER_OWNED_REGION_KEYS = [
  "origin",
  "approvalRequired",
  "lockedRegions",
] as const satisfies readonly (keyof LockableDefinition)[];
type ServerOwnedRegionKey = (typeof SERVER_OWNED_REGION_KEYS)[number];
const SERVER_OWNED_REGION_PATHS: ReadonlySet<string> = new Set(
  SERVER_OWNED_REGION_KEYS.map((key) => `/${key}`),
);

const ID_KEY_BY_COLLECTION: Readonly<Record<string, "id" | "name">> = {
  executionContexts: "id",
  tasks: "id",
  edges: "id",
  parameters: "name",
};

function parsePath(path: string): string[] {
  if (path.startsWith("/")) {
    return path
      .slice(1)
      .split("/")
      .filter(Boolean)
      .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  }

  return path
    .replace(/^\$\.?/, "")
    .replace(/\[["']([^"']+)["']\]/g, ".$1")
    .replace(/\[([^\]]+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
}

function canonicalizePath(
  definition: LockableDefinition,
  rawPath: string,
): string[] {
  const segments = parsePath(rawPath);
  if (segments[0] === "definition" || segments[0] === "workingDefinition") {
    segments.shift();
  }

  for (let index = 0; index < segments.length - 1; index += 1) {
    const collection = segments[index]!;
    const idKey = ID_KEY_BY_COLLECTION[collection];
    const selector = segments[index + 1]!;
    if (!idKey || !/^\d+$/.test(selector)) continue;

    const value = (definition as unknown as Record<string, unknown>)[
      collection
    ];
    if (!Array.isArray(value)) continue;
    const selected = value[Number(selector)] as
      | Record<string, unknown>
      | undefined;
    const stableId = selected?.[idKey];
    if (typeof stableId === "string") {
      segments[index + 1] = stableId;
    }
  }

  return segments;
}

function pathsOverlap(left: DefinitionPath, right: DefinitionPath): boolean {
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftSegment = left[index];
    const rightSegment = right[index];
    if (
      leftSegment !== rightSegment &&
      leftSegment !== "*" &&
      rightSegment !== "*"
    ) {
      return false;
    }
  }
  return true;
}

interface SelectedValue {
  path: DefinitionPath;
  value: unknown;
}

function valuesAtPath(
  definition: LockableDefinition,
  rawPath: string,
): SelectedValue[] {
  const segments = canonicalizePath(definition, rawPath);
  const selected: SelectedValue[] = [];

  function visit(
    current: unknown,
    index: number,
    concretePath: readonly string[],
  ): void {
    if (index === segments.length) {
      selected.push({ path: concretePath, value: current });
      return;
    }

    const segment = segments[index]!;
    if (segment === "*") {
      if (Array.isArray(current)) {
        const collection = segments[index - 1];
        const idKey = collection ? ID_KEY_BY_COLLECTION[collection] : undefined;
        current.forEach((entry, entryIndex) => {
          const stableId =
            idKey && typeof entry === "object" && entry !== null
              ? (entry as Record<string, unknown>)[idKey]
              : undefined;
          const selector =
            typeof stableId === "string" ? stableId : String(entryIndex);
          visit(entry, index + 1, [...concretePath, selector]);
        });
        return;
      }
      if (typeof current !== "object" || current === null) return;
      for (const [key, value] of Object.entries(current)) {
        visit(value, index + 1, [...concretePath, key]);
      }
      return;
    }

    if (Array.isArray(current)) {
      const collection = segments[index - 1];
      const idKey = collection ? ID_KEY_BY_COLLECTION[collection] : undefined;
      if (/^\d+$/.test(segment)) {
        visit(current[Number(segment)], index + 1, [...concretePath, segment]);
        return;
      }
      if (!idKey) return;
      const entry = current.find(
        (entry) =>
          typeof entry === "object" &&
          entry !== null &&
          (entry as Record<string, unknown>)[idKey] === segment,
      );
      if (entry !== undefined) {
        visit(entry, index + 1, [...concretePath, segment]);
      }
      return;
    }
    if (typeof current !== "object" || current === null) return;
    const record = current as Record<string, unknown>;
    if (!(segment in record)) return;
    visit(record[segment], index + 1, [...concretePath, segment]);
  }

  visit(definition, 0, []);
  return selected.sort((left, right) =>
    JSON.stringify(left.path).localeCompare(JSON.stringify(right.path)),
  );
}

export function findLockedRegionTouch(
  definition: LockableDefinition,
  touchedPaths: readonly DefinitionPath[],
): LockedRegionMatch | null {
  for (const region of definition.lockedRegions ?? []) {
    for (const lockedPath of region.paths) {
      const canonicalLockedPath = canonicalizePath(definition, lockedPath);
      if (
        touchedPaths.some((touchedPath) =>
          pathsOverlap(canonicalLockedPath, touchedPath),
        )
      ) {
        return { ...region, lockedPath };
      }
    }
  }
  return null;
}

export function findChangedLockedRegion(
  previous: LockableDefinition,
  next: LockableDefinition,
): LockedRegionMatch | null {
  const regions = previous.lockedRegions ?? [];
  const first = regions[0];
  if (first === undefined) return null;

  if (!isDeepStrictEqual(previous.lockedRegions, next.lockedRegions)) {
    return { ...first, lockedPath: "/lockedRegions" };
  }

  for (const region of regions) {
    for (const lockedPath of region.paths) {
      if (
        !isDeepStrictEqual(
          valuesAtPath(previous, lockedPath),
          valuesAtPath(next, lockedPath),
        )
      ) {
        return { ...region, lockedPath };
      }
    }
  }
  return null;
}

/**
 * The remedy a refusal prints. A region that declared its own escape names it;
 * everything else falls back to the generic source-amendment and recompile
 * sentence.
 */
export function regionLockedInstruction(match: LockedRegionMatch): string {
  return (
    match.instruction ??
    `Amend at source ${match.sourceUri} and recompile the workflow definition.`
  );
}

export function regionLockedMessage(match: LockedRegionMatch): string {
  return match.instruction === undefined
    ? `Path "${match.lockedPath}" is locked because ${match.reason}; amend at source ${match.sourceUri} and recompile the workflow definition.`
    : `Path "${match.lockedPath}" is locked because ${match.reason}. ${match.instruction}`;
}

/**
 * Fill the server-owned regions (`/origin`, `/approvalRequired`,
 * `/lockedRegions`) a submitted definition omits from the stored record, so a
 * plan authored without them reaches {@link findChangedLockedRegion} carrying
 * the values the server stamped and only a present-and-different value can
 * trip the lock. A key absent from both stays absent: an explicitly-undefined
 * key would serialize as `null` and change the stored bytes.
 */
export function mergeServerOwnedRegions<T extends LockableDefinition>(
  previous: LockableDefinition,
  next: T,
): T {
  const filled: Partial<Pick<LockableDefinition, ServerOwnedRegionKey>> = {};
  for (const key of SERVER_OWNED_REGION_KEYS) {
    if (next[key] !== undefined || previous[key] === undefined) continue;
    Object.assign(filled, { [key]: previous[key] });
  }
  return { ...next, ...filled };
}

/**
 * The locked paths {@link mergeServerOwnedRegions} would fill for this pair —
 * what the submitted plan omitted and the stored record supplies. Reported
 * separately from the merge so the write can log which fields it stamped
 * without the merge growing a second return value every caller must thread.
 */
export function serverOwnedRegionPathsFilled(
  previous: LockableDefinition,
  next: LockableDefinition,
): string[] {
  return SERVER_OWNED_REGION_KEYS.filter(
    (key) => next[key] === undefined && previous[key] !== undefined,
  ).map((key) => `/${key}`);
}

/**
 * True when a locked path is one the server stamps on a managed definition:
 * the refusal for it tells the author to omit the field rather than to amend
 * it at source, because the value was never theirs to author.
 */
export function isServerOwnedRegionPath(lockedPath: string): boolean {
  return SERVER_OWNED_REGION_PATHS.has(lockedPath);
}
