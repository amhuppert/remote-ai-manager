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
    expect(paths(result.undischarged)).toEqual([
      "taskStates.*.failureHistory",
    ]);
  });

  it("covers a whole subtree with a `.**` discharge", () => {
    const result = reconcileDischarges(found, {
      pendingQueue: "pruned",
      "taskStates.**": "immutable subtree",
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
      "taskStates.**": "immutable subtree",
      removedField: "no longer exists",
    });
    expect(result.staleDischargeKeys).toEqual(["removedField"]);
  });

  it("reports a stale `.**` discharge whose subtree is gone", () => {
    const result = reconcileDischarges(found, {
      "pendingQueue.**": "pruned",
      "taskStates.**": "immutable subtree",
      "workingDefinition.**": "no nodes under here",
    });
    expect(result.staleDischargeKeys).toEqual(["workingDefinition.**"]);
  });
});
