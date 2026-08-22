/**
 * The ordered-collection edits the Brief and Tasks screens share. Ids and
 * `order` are cited by validators and dispatched against, so the rules that
 * matter are: reordering never renames, and removal never leaves a gap or
 * frees an id a citation still points at.
 */
import { describe, expect, it } from "vitest";
import type { GraphWorkflowTaskDefinition } from "@/lib/workflow-graph/definition-schemas";
import {
  criteriaRecords,
  moveItem,
  nextCriterionId,
  nextTaskId,
  removeItem,
  renumberTasks,
} from "./ordered-edits";

function task(
  id: string,
  order: number,
  title = id,
): GraphWorkflowTaskDefinition {
  return {
    id,
    contextId: "ctx_checkout",
    order,
    title,
    instructions: "do the thing",
    source: "user",
  };
}

describe("moveItem", () => {
  it("moves an item up without disturbing the rest of the order", () => {
    expect(moveItem(["a", "b", "c"], 1, 0)).toEqual(["b", "a", "c"]);
  });

  it("moves an item down without disturbing the rest of the order", () => {
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
  });

  it("leaves the list alone when the target is off either end", () => {
    expect(moveItem(["a", "b"], 0, -1)).toEqual(["a", "b"]);
    expect(moveItem(["a", "b"], 1, 2)).toEqual(["a", "b"]);
  });

  it("returns a new array rather than splicing the caller's state", () => {
    const original = ["a", "b"];
    expect(moveItem(original, 0, 1)).not.toBe(original);
    expect(original).toEqual(["a", "b"]);
  });
});

describe("removeItem", () => {
  it("drops exactly the indexed entry", () => {
    expect(removeItem(["a", "b", "c"], 1)).toEqual(["a", "c"]);
  });
});

describe("nextCriterionId", () => {
  it("numbers past the end of the list", () => {
    expect(nextCriterionId([{ id: "ac-1", statement: "one" }])).toBe("ac-2");
  });

  it("skips an id a surviving criterion still holds", () => {
    // `ac-1` was removed, so length+1 collides with the criterion validators
    // already cite as `ac-2`.
    expect(nextCriterionId([{ id: "ac-2", statement: "two" }])).toBe("ac-3");
  });
});

describe("criteriaRecords", () => {
  it("carries records through unchanged", () => {
    const records = [{ id: "ac-4", statement: "four" }];
    expect(criteriaRecords(records)).toEqual(records);
  });

  it("canonicalizes legacy prose to the deterministic single record", () => {
    expect(criteriaRecords("ships behind a flag")).toEqual([
      { id: "ac-1", statement: "ships behind a flag" },
    ]);
  });
});

describe("renumberTasks", () => {
  it("rewrites order as a contiguous run over the array sequence", () => {
    const reordered = moveItem(
      [task("a", 1), task("b", 2), task("c", 3)],
      2,
      0,
    );
    expect(
      renumberTasks(reordered).map((each) => [each.id, each.order]),
    ).toEqual([
      ["c", 1],
      ["a", 2],
      ["b", 3],
    ]);
  });

  it("closes the gap a removal leaves", () => {
    const remaining = removeItem([task("a", 1), task("b", 2), task("c", 3)], 1);
    expect(renumberTasks(remaining).map((each) => each.order)).toEqual([1, 2]);
  });

  it("preserves every field it does not renumber", () => {
    const withMetadata: GraphWorkflowTaskDefinition = {
      ...task("a", 7),
      metadata: { origin: "spec" },
    };
    expect(renumberTasks([withMetadata])[0]).toEqual({
      ...withMetadata,
      order: 1,
    });
  });
});

describe("nextTaskId", () => {
  it("qualifies the id with the context that will own the task", () => {
    expect(nextTaskId("ctx_checkout", 2, ["task-ctx_checkout-1"])).toBe(
      "task-ctx_checkout-2",
    );
  });

  it("walks past an id a task in ANOTHER context already holds", () => {
    // The reported defect: `context-1` has one task, `context-2` owns `task-2`,
    // and task ids are unique workflow-wide — so numbering off the context's
    // own list alone mints the duplicate the definition validator rejects.
    expect(nextTaskId("context-1", 2, ["task-1", "task-2"])).toBe(
      "task-context-1-2",
    );
  });

  it("keeps the builder's short id when nothing in the workflow holds it", () => {
    expect(nextTaskId("context-1", 1, [])).toBe("task-1");
  });

  it("never returns an id already taken, whatever the shape", () => {
    expect(nextTaskId("context-1", 1, ["task-1", "task-context-1-2"])).toBe(
      "task-context-1-3",
    );
  });
});
