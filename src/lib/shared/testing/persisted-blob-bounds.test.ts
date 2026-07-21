import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  findUnboundedCollections,
  reconcileDischarges,
  type UnboundedCollection,
} from "./persisted-blob-bounds";

function paths(found: readonly UnboundedCollection[]): string[] {
  return found.map((node) => node.path).sort();
}

describe("findUnboundedCollections", () => {
  it("flags a bare unbounded array at the root", () => {
    const found = findUnboundedCollections(z.array(z.string()));
    expect(found).toEqual([{ path: "", kind: "array" }]);
  });

  it("does not flag an array with a static max", () => {
    expect(findUnboundedCollections(z.array(z.string()).max(10))).toEqual([]);
  });

  it("flags an unbounded array field but not a bounded sibling", () => {
    const schema = z.object({
      growing: z.array(z.string()),
      capped: z.array(z.string()).max(5),
      name: z.string(),
    });
    expect(paths(findUnboundedCollections(schema))).toEqual(["growing"]);
  });

  it("flags an open record (map) as unbounded", () => {
    const schema = z.object({
      byId: z.record(z.string(), z.number()),
    });
    const found = findUnboundedCollections(schema);
    expect(found).toEqual([{ path: "byId", kind: "record" }]);
  });

  it("does not flag a fixed-key object", () => {
    const schema = z.object({
      a: z.string(),
      nested: z.object({ b: z.number() }),
    });
    expect(findUnboundedCollections(schema)).toEqual([]);
  });

  it("finds an unbounded array nested under a record value", () => {
    const schema = z.object({
      tasks: z.record(z.string(), z.object({ history: z.array(z.string()) })),
    });
    expect(paths(findUnboundedCollections(schema))).toEqual([
      "tasks",
      "tasks.*.history",
    ]);
  });

  it("sees through nullable, optional, and default wrappers", () => {
    const schema = z.object({
      maybe: z.array(z.string()).nullable().default(null),
      opt: z.array(z.string()).optional(),
    });
    expect(paths(findUnboundedCollections(schema))).toEqual(["maybe", "opt"]);
  });

  it("recurses into array elements", () => {
    const schema = z.object({
      rows: z.array(z.object({ cells: z.array(z.string()) })),
    });
    expect(paths(findUnboundedCollections(schema))).toEqual([
      "rows",
      "rows[].cells",
    ]);
  });

  it("flags an opaque unknown field", () => {
    const schema = z.object({ blob: z.unknown(), name: z.string() });
    expect(findUnboundedCollections(schema)).toEqual([
      { path: "blob", kind: "opaque" },
    ]);
  });

  it("flags an opaque any field", () => {
    const schema = z.object({ blob: z.any() });
    expect(findUnboundedCollections(schema)).toEqual([
      { path: "blob", kind: "opaque" },
    ]);
  });

  it("flags the opaque value of an open record of unknowns (map and value)", () => {
    const schema = z.object({ byId: z.record(z.string(), z.unknown()) });
    expect(paths(findUnboundedCollections(schema))).toEqual(["byId", "byId.*"]);
    const kinds = findUnboundedCollections(schema)
      .map((c) => c.kind)
      .sort();
    expect(kinds).toEqual(["opaque", "record"]);
  });

  it("does not flag a transform output as opaque (opaque only in the output projection)", () => {
    // A `.transform()` arm renders as `{}` in the OUTPUT projection (Zod cannot
    // statically type a transform's result) but as its typed input in the INPUT
    // projection — this is the `conversationStatusSchema` legacy-normalizer
    // shape. A genuine opaque node is `{}` in both directions, so the detector
    // must not flag this.
    const schema = z.object({
      status: z
        .enum(["a", "b"])
        .or(z.enum(["c", "d"]).transform(() => "a" as const)),
    });
    expect(findUnboundedCollections(schema)).toEqual([]);
  });

  it("does not flag a lenient decoder tolerant of extra keys (opaque only in the input projection)", () => {
    // A union of transform arms that tolerate a superset of keys renders an
    // opaque map value in the INPUT projection but a typed/`{}` transform in the
    // OUTPUT projection at a different path — the `persistedAgentSessionRefSchema`
    // shape. Opacity in only one direction is a projection artifact, not a
    // genuinely opaque persisted value.
    const superset = z
      .looseObject({ backend: z.string(), ref: z.string() })
      .transform((v) => ({ backend: v.backend, ref: v.ref }));
    const canonical = z.object({ backend: z.string(), ref: z.string() });
    const schema = z.object({ sourceRef: z.union([canonical, superset]) });
    expect(
      findUnboundedCollections(schema).filter((c) => c.kind === "opaque"),
    ).toEqual([]);
  });

  it("does not flag the root object or typed fields", () => {
    const schema = z.object({ a: z.string(), b: z.number() });
    expect(findUnboundedCollections(schema)).toEqual([]);
  });
});

describe("reconcileDischarges", () => {
  const found: UnboundedCollection[] = [
    { path: "pendingQueue", kind: "array" },
    { path: "taskStates", kind: "record" },
    { path: "taskStates.*.failureHistory", kind: "array" },
  ];

  it("reports nothing when every collection is discharged exactly", () => {
    const result = reconcileDischarges(found, {
      pendingQueue: "pruned to active entries",
      taskStates: "keyed by author-fixed task graph",
      "taskStates.*.failureHistory": "capped to last 10",
    });
    expect(result.undischarged).toEqual([]);
    expect(result.staleDischargeKeys).toEqual([]);
  });

  it("matches keys exactly so a descendant is not silently covered", () => {
    // An exact `taskStates` discharge must NOT cover the nested failureHistory:
    // a new collection beside a discharged one still has to be declared.
    const result = reconcileDischarges(found, {
      pendingQueue: "pruned",
      taskStates: "keyed by task graph",
    });
    expect(paths(result.undischarged)).toEqual(["taskStates.*.failureHistory"]);
  });

  it("covers a whole subtree with a `.**` discharge", () => {
    const result = reconcileDischarges(found, {
      pendingQueue: "pruned",
      "taskStates.**": "bounded subtree",
    });
    expect(result.undischarged).toEqual([]);
    expect(result.staleDischargeKeys).toEqual([]);
  });

  it("reports an undischarged collection", () => {
    const result = reconcileDischarges(found, {
      pendingQueue: "pruned",
    });
    expect(paths(result.undischarged)).toEqual([
      "taskStates",
      "taskStates.*.failureHistory",
    ]);
  });

  it("reports a stale exact discharge that covers nothing", () => {
    const result = reconcileDischarges(found, {
      "pendingQueue.**": "pruned",
      "taskStates.**": "bounded subtree",
      removedField: "no longer exists",
    });
    expect(result.staleDischargeKeys).toEqual(["removedField"]);
  });

  it("reports a stale `.**` discharge whose subtree is gone", () => {
    const result = reconcileDischarges(found, {
      "pendingQueue.**": "pruned",
      "taskStates.**": "bounded subtree",
      "workingDefinition.**": "no nodes under here",
    });
    expect(result.staleDischargeKeys).toEqual(["workingDefinition.**"]);
  });

  describe("opaque findings require an opaque-appropriate discharge", () => {
    const opaque: UnboundedCollection[] = [
      { path: "machineSnapshot", kind: "opaque" },
    ];

    it("clears an opaque node discharged with `tracked:`", () => {
      const result = reconcileDischarges(opaque, {
        machineSnapshot:
          "tracked: opaque XState snapshot, addressed separately",
      });
      expect(result.undischarged).toEqual([]);
      expect(result.staleDischargeKeys).toEqual([]);
    });

    it("does NOT clear an opaque node with a `bounded:` discharge", () => {
      // You cannot honestly claim you inspected an opaque value and found it
      // bounded — `bounded:`/`pruned:` are for collections whose shape is
      // visible. An opaque node must be `tracked:` (or shown not to live in the
      // blob at all).
      const result = reconcileDischarges(opaque, {
        machineSnapshot: "bounded: it's fine trust me",
      });
      expect(paths(result.undischarged)).toEqual(["machineSnapshot"]);
    });

    it("does NOT clear an opaque node with a `pruned:` discharge", () => {
      const result = reconcileDischarges(opaque, {
        machineSnapshot: "pruned: somewhere",
      });
      expect(paths(result.undischarged)).toEqual(["machineSnapshot"]);
    });

    it("clears an opaque node whose subtree is `normalized:` (not in the blob)", () => {
      const nested: UnboundedCollection[] = [
        { path: "conversations[].payload", kind: "opaque" },
      ];
      const result = reconcileDischarges(nested, {
        "conversations.**":
          "normalized: conversations table; never on this row",
      });
      expect(result.undischarged).toEqual([]);
    });

    it("clears an opaque node whose subtree is `not-persisted:`", () => {
      const nested: UnboundedCollection[] = [
        { path: "graphWorkflowExecution.machineSnapshot", kind: "opaque" },
      ];
      const result = reconcileDischarges(nested, {
        "graphWorkflowExecution.**": "not-persisted: null on this row",
      });
      expect(result.undischarged).toEqual([]);
    });

    it("reports an undischarged opaque node with no covering key", () => {
      const result = reconcileDischarges(opaque, {});
      expect(paths(result.undischarged)).toEqual(["machineSnapshot"]);
    });
  });
});
