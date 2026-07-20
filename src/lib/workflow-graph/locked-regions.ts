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
  if (regions.length === 0) return null;

  if (!isDeepStrictEqual(previous.lockedRegions, next.lockedRegions)) {
    return { ...regions[0]!, lockedPath: "lockedRegions" };
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

export function regionLockedInstruction(sourceUri: string): string {
  return `Amend at source ${sourceUri} and recompile the workflow definition.`;
}

export function regionLockedMessage(match: LockedRegionMatch): string {
  return `Path "${match.lockedPath}" is locked because ${match.reason}; amend at source ${match.sourceUri} and recompile the workflow definition.`;
}
