import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  D4_ADDITIVE_FIELDS,
  PRE_D4_MUTABILITY_FIELDS,
} from "@/lib/workflow-graph/compat/floor";
import {
  canonicalValuesAtPath,
  collectValuesAtPath,
  isEmptyForFixture,
  resolveExecutionSchemaAtPath,
  stripD4PersistedFields,
  D4_D12_DIVERGENCES,
  D4_PERSISTED_FIELDS,
} from "./d4-persisted-field-inventory";

type FloorBucket = keyof typeof D4_ADDITIVE_FIELDS;

/**
 * Where an inventory path is probed for dormancy, and under what field name.
 * The floor probes read one level below each container they walk, so a nested
 * path (`loopStates.*.slotLedger`) reduces to the container the probe actually
 * checks (`loopStates`) — registering that container covers everything beneath.
 */
function floorEntryFor(path: string): { bucket: FloorBucket; field: string } {
  // `loopGroups[].until` and `loopGroups` name the same container to a probe
  // that reads one level down, so the element marker is dropped.
  const container = (segment: string): string => segment.replace(/\[\]$/, "");
  const after = (prefix: string): string =>
    container(path.slice(prefix.length).split(".")[0] ?? "");
  if (path.startsWith("workingDefinition.edges[].")) {
    return { bucket: "edge", field: after("workingDefinition.edges[].") };
  }
  if (path.startsWith("workingDefinition.executionContexts[].")) {
    return {
      bucket: "context",
      field: after("workingDefinition.executionContexts[]."),
    };
  }
  if (path.startsWith("workingDefinition.")) {
    return { bucket: "definition", field: after("workingDefinition.") };
  }
  if (path.startsWith("contextStates.*.")) {
    return { bucket: "contextState", field: after("contextStates.*.") };
  }
  return { bucket: "execution", field: container(path.split(".")[0] ?? "") };
}

/**
 * Inventory fields the floor probes deliberately do NOT read as D4 evidence.
 * Both are cases where presence is not authorship, so a probe keyed on presence
 * would report a pre-D4 execution as post-D4.
 */
const FLOOR_EXEMPTIONS: ReadonlyArray<{
  readonly bucket: FloorBucket;
  readonly field: string;
  readonly why: string;
}> = [
  {
    bucket: "edge",
    field: "id",
    why: "every edge carries an id after the inflate-time repair, including a legacy one — so an id proves nothing about when the definition was authored, and only `when` distinguishes a conditional edge",
  },
  {
    bucket: "context",
    field: "mutability",
    why: "expansion authority is a cascaded mutability flag, probed by VALUE (grantsExpansionAuthority) against PRE_D4_MUTABILITY_FIELDS rather than by the presence of a guessed key name",
  },
];

function isExempt(bucket: FloorBucket, field: string): boolean {
  return FLOOR_EXEMPTIONS.some(
    (entry) => entry.bucket === bucket && entry.field === field,
  );
}

/**
 * The inventory and the compat floor's field list are two declarations of the
 * same set, kept apart because one is persistence's authority (decision D12) and
 * the other is what the dormancy probes actually look at. Drift between them is
 * silent in both directions and defeats each list's purpose, so it is asserted
 * rather than trusted: a field only the inventory knows is a field the floor
 * stops noticing, and a field only the floor knows is a persisted field with no
 * round-trip proof behind it.
 */
describe("D4 persisted-field inventory vs the compat floor field list", () => {
  it("registers every inventory field with the floor probe that reads it", () => {
    const unregistered = D4_PERSISTED_FIELDS.filter((field) => {
      const entry = floorEntryFor(field.path);
      if (isExempt(entry.bucket, entry.field)) return false;
      const registered: readonly string[] = D4_ADDITIVE_FIELDS[entry.bucket];
      return !registered.includes(entry.field);
    }).map((field) => field.path);

    expect(
      unregistered,
      "an inventory field absent from D4_ADDITIVE_FIELDS is invisible to the dormancy probes",
    ).toEqual([]);
  });

  it("keeps every floor-registered field in the inventory", () => {
    const inventoryEntries = new Set(
      D4_PERSISTED_FIELDS.map((field) => {
        const entry = floorEntryFor(field.path);
        return `${entry.bucket}.${entry.field}`;
      }),
    );

    const uninventoried = Object.entries(D4_ADDITIVE_FIELDS).flatMap(
      ([bucket, fields]) =>
        fields
          .filter((field) => !inventoryEntries.has(`${bucket}.${field}`))
          .map((field) => `${bucket}.${field}`),
    );

    expect(
      uninventoried,
      "a field the floor probes call D4 but the inventory omits has no round-trip, no blob-bounds answer, and no floor fixture",
    ).toEqual([]);
  });

  // The exemptions are the interesting half of the coupling: an exemption that
  // stops naming a real inventory field is an exemption that silently excuses
  // nothing, and would hide the next field that lands on the same name.
  it("keeps every floor exemption pointed at a real inventory field", () => {
    const stale = FLOOR_EXEMPTIONS.filter(
      (exemption) =>
        !D4_PERSISTED_FIELDS.some((field) => {
          const entry = floorEntryFor(field.path);
          return (
            entry.bucket === exemption.bucket && entry.field === exemption.field
          );
        }),
    ).map((exemption) => `${exemption.bucket}.${exemption.field}`);

    expect(stale).toEqual([]);
    expect(PRE_D4_MUTABILITY_FIELDS).not.toContain("allowAgentContextAdd");
  });
});

describe("D4 divergences from decision D12", () => {
  // The record exists to be auditable, which means it has to be kept honest by
  // something other than good intentions: a divergence whose production path no
  // longer resolves is describing a schema that no longer exists.
  it("resolves every recorded production path in the execution schema", () => {
    const unresolved = D4_D12_DIVERGENCES.filter(
      (divergence) =>
        divergence.productionPath !== null &&
        resolveExecutionSchemaAtPath(divergence.productionPath) === null,
    ).map((divergence) => divergence.d12Field);
    expect(unresolved).toEqual([]);
  });

  it("records a null production path only for a derived field", () => {
    const storedButNull = D4_D12_DIVERGENCES.filter(
      (divergence) =>
        divergence.productionPath === null && divergence.kind !== "derived",
    ).map((divergence) => divergence.d12Field);
    expect(storedButNull).toEqual([]);
  });

  // The two renames the record claims are one-for-one. Pinning the SHIPPED
  // vocabulary here means conforming either field to D12 later fails this test
  // until its divergence entry is removed — so the record cannot outlive the
  // divergence it describes.
  it("pins the shipped vocabulary each rename diverges to", () => {
    const activation = resolveExecutionSchemaAtPath("loopStates.*.activation");
    expect(activation).toBeInstanceOf(z.ZodEnum);
    if (activation instanceof z.ZodEnum) {
      expect(new Set(activation.options)).toEqual(
        new Set(["unstarted", "running", "concluded", "skipped"]),
      );
    }

    const landingState = resolveExecutionSchemaAtPath(
      "contextStates.*.landingIntent.state",
    );
    expect(landingState).toBeInstanceOf(z.ZodEnum);
    if (landingState instanceof z.ZodEnum) {
      expect(new Set(landingState.options)).toEqual(
        new Set(["pending", "landed", "failed"]),
      );
    }
  });

  // D12's `receipts` are re-encoded flat, so what makes the round-trip honest is
  // that the flat carriers exist for every mode the schema admits.
  it("keeps a carrier for every landing mode's evidence", () => {
    const mode = resolveExecutionSchemaAtPath(
      "contextStates.*.landingIntent.mode",
    );
    expect(mode).toBeInstanceOf(z.ZodEnum);
    if (mode instanceof z.ZodEnum) {
      expect(new Set(mode.options)).toEqual(
        new Set(["lane_commit", "solo_commit", "fan_in_merge"]),
      );
    }
    for (const carrier of ["headSha", "joinId", "worktreePath", "evidence"]) {
      expect(
        resolveExecutionSchemaAtPath(
          `contextStates.*.landingIntent.${carrier}`,
        ),
        `landingIntent.${carrier} carries mode-specific landing evidence`,
      ).not.toBeNull();
    }
  });
});

describe("stripD4PersistedFields", () => {
  // The pre-D4 fixtures both floor suites seed are DERIVED by this function, so
  // a strip that quietly missed a field would seed a "pre-D4" row that still
  // carried D4 state — and the floor would be proven against nothing.
  it("removes every inventory path from a populated execution", () => {
    const populated = {
      workingDefinition: {
        edges: [
          {
            sourceContextId: "a",
            targetContextId: "b",
            id: "a__b",
            when: { verdict: "go" },
          },
        ],
        executionContexts: [
          {
            id: "a",
            routing: { cardinality: "exactlyOne" },
            mutability: { allowAgentTaskAdd: true, allowAgentContextAdd: true },
          },
        ],
        loopGroups: [{ id: "loop-1", entryContextId: "a", exitContextId: "a" }],
      },
      contextStates: {
        a: {
          contextId: "a",
          skipReason: { kind: "branch_not_taken" },
          landingIntent: { mode: "solo_commit" },
        },
      },
      routeSettlements: { a: { captureIteration: 1 } },
      routeControlRevisions: { a: 2 },
      loopStates: { "loop-1": { activation: "concluded", passCount: 2 } },
      expansionReceipts: { accepted: [{ requestId: "r1" }], refusals: [] },
    };

    const stripped = stripD4PersistedFields(populated);

    const surviving = D4_PERSISTED_FIELDS.filter(
      (field) =>
        !collectValuesAtPath(stripped, field.path).every(isEmptyForFixture),
    ).map((field) => field.path);
    expect(surviving).toEqual([]);
  });

  it("leaves pre-D4 state untouched", () => {
    const stripped = stripD4PersistedFields({
      id: "wf-1",
      workingDefinition: {
        edges: [{ sourceContextId: "a", targetContextId: "b", id: "a__b" }],
        executionContexts: [
          { id: "a", mutability: { allowAgentTaskAdd: true } },
        ],
      },
      contextStates: { a: { contextId: "a", status: "completed" } },
    });

    expect(stripped).toEqual({
      id: "wf-1",
      workingDefinition: {
        edges: [{ sourceContextId: "a", targetContextId: "b" }],
        executionContexts: [
          { id: "a", mutability: { allowAgentTaskAdd: true } },
        ],
      },
      contextStates: { a: { contextId: "a", status: "completed" } },
    });
  });
});

describe("canonicalValuesAtPath", () => {
  // Record expansion order is insertion order, and nothing guarantees a reloaded
  // blob rebuilt its maps in the order the fixture wrote them.
  it("orders a record expansion by content, not by key order", () => {
    const written = { byId: { b: { n: 2 }, a: { n: 1 } } };
    const reloaded = { byId: { a: { n: 1 }, b: { n: 2 } } };

    expect(canonicalValuesAtPath(reloaded, "byId.*")).toEqual(
      canonicalValuesAtPath(written, "byId.*"),
    );
  });

  it("still fails when a value was mutated rather than reordered", () => {
    const written = { byId: { a: { n: 1 }, b: { n: 2 } } };
    const mutated = { byId: { a: { n: 1 }, b: { n: 99 } } };

    expect(canonicalValuesAtPath(mutated, "byId.*")).not.toEqual(
      canonicalValuesAtPath(written, "byId.*"),
    );
  });

  it("orders equal-content values stably regardless of key insertion order", () => {
    expect(
      canonicalValuesAtPath({ byId: { a: { x: 1, y: 2 } } }, "byId.*"),
    ).toEqual(canonicalValuesAtPath({ byId: { a: { y: 2, x: 1 } } }, "byId.*"));
  });
});
