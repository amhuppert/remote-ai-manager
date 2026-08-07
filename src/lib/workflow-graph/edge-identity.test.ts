import { describe, expect, it } from "vitest";
import { mintEdgeId, normalizeRawDefinitionEdgeIds } from "./edge-identity";

function rawEdges(value: unknown): unknown[] {
  const definition = value as { edges?: unknown };
  return Array.isArray(definition.edges) ? definition.edges : [];
}

describe("mintEdgeId", () => {
  it("uses the source__target base when it is free", () => {
    expect(mintEdgeId(new Set<string>(), "plan", "build")).toBe("plan__build");
  });

  it("appends the next free ordinal when the base is taken", () => {
    expect(mintEdgeId(new Set(["plan__build"]), "plan", "build")).toBe(
      "plan__build-2",
    );
    expect(
      mintEdgeId(new Set(["plan__build", "plan__build-2"]), "plan", "build"),
    ).toBe("plan__build-3");
  });
});

describe("normalizeRawDefinitionEdgeIds", () => {
  it("leaves a definition whose edge ids are already unique untouched", () => {
    const definition = {
      edges: [
        { id: "e1", sourceContextId: "a", targetContextId: "b" },
        { id: "e2", sourceContextId: "b", targetContextId: "c" },
      ],
    };

    normalizeRawDefinitionEdgeIds(definition);

    expect(rawEdges(definition)).toEqual([
      { id: "e1", sourceContextId: "a", targetContextId: "b" },
      { id: "e2", sourceContextId: "b", targetContextId: "c" },
    ]);
  });

  it("mints an id for an edge that carries none", () => {
    const definition = {
      edges: [{ sourceContextId: "a", targetContextId: "b" }],
    };

    normalizeRawDefinitionEdgeIds(definition);

    expect(rawEdges(definition)).toEqual([
      { id: "a__b", sourceContextId: "a", targetContextId: "b" },
    ]);
  });

  it("renames duplicates by ordinal, keeping the first occurrence", () => {
    const definition = {
      edges: [
        { id: "dup", sourceContextId: "a", targetContextId: "b" },
        { id: "dup", sourceContextId: "a", targetContextId: "c" },
        { id: "dup", sourceContextId: "b", targetContextId: "c" },
      ],
    };

    normalizeRawDefinitionEdgeIds(definition);

    expect(
      rawEdges(definition).map((edge) => (edge as { id: string }).id),
    ).toEqual(["dup", "a__c", "b__c"]);
  });

  it("resolves a minted id colliding with a later explicit id by ordinal", () => {
    const definition = {
      edges: [
        { sourceContextId: "a", targetContextId: "b" },
        { id: "a__b", sourceContextId: "a", targetContextId: "b" },
      ],
    };

    normalizeRawDefinitionEdgeIds(definition);

    expect(
      rawEdges(definition).map((edge) => (edge as { id: string }).id),
    ).toEqual(["a__b", "a__b-2"]);
  });

  it("is idempotent — a second pass over a normalized definition changes nothing", () => {
    const definition = {
      edges: [
        { id: "dup", sourceContextId: "a", targetContextId: "b" },
        { id: "dup", sourceContextId: "a", targetContextId: "b" },
        { sourceContextId: "a", targetContextId: "b" },
      ],
    };

    normalizeRawDefinitionEdgeIds(definition);
    const afterFirst = structuredClone(rawEdges(definition));
    normalizeRawDefinitionEdgeIds(definition);

    expect(rawEdges(definition)).toEqual(afterFirst);
    expect(afterFirst.map((edge) => (edge as { id: string }).id)).toEqual([
      "dup",
      "a__b",
      "a__b-2",
    ]);
  });

  it("normalizes identically on every load of the same stored document", () => {
    const stored = `{"edges":[
      {"id":"x","sourceContextId":"a","targetContextId":"b"},
      {"id":"x","sourceContextId":"a","targetContextId":"c"},
      {"sourceContextId":"a","targetContextId":"c"}
    ]}`;

    const first: unknown = JSON.parse(stored);
    const second: unknown = JSON.parse(stored);
    normalizeRawDefinitionEdgeIds(first);
    normalizeRawDefinitionEdgeIds(second);

    expect(first).toEqual(second);
  });

  it("replaces a blank or non-string id", () => {
    const definition = {
      edges: [
        { id: "   ", sourceContextId: "a", targetContextId: "b" },
        { id: 7, sourceContextId: "b", targetContextId: "c" },
      ],
    };

    normalizeRawDefinitionEdgeIds(definition);

    expect(
      rawEdges(definition).map((edge) => (edge as { id: string }).id),
    ).toEqual(["a__b", "b__c"]);
  });

  it("ignores a value that carries no edges array", () => {
    expect(() => normalizeRawDefinitionEdgeIds(null)).not.toThrow();
    expect(() =>
      normalizeRawDefinitionEdgeIds({ edges: "nope" }),
    ).not.toThrow();
    expect(() => normalizeRawDefinitionEdgeIds({})).not.toThrow();
  });

  it("leaves an edge with unusable endpoints alone for the structural validator to refuse", () => {
    const definition = { edges: [{ sourceContextId: "a" }] };

    normalizeRawDefinitionEdgeIds(definition);

    expect(rawEdges(definition)).toEqual([{ sourceContextId: "a" }]);
  });
});
