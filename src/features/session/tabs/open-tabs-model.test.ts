import { describe, it, expect } from "vitest";

import {
  MAX_OPEN_TABS,
  emptyModel,
  openInSet,
  closeTab,
  reconcile,
  type OpenTabsModel,
} from "./open-tabs-model";

function snapshot(model: OpenTabsModel): {
  tabs: string[];
  lru: string[];
} {
  return { tabs: [...model.tabs], lru: [...model.lru] };
}

/** The two orders must always describe the exact same set of ids. */
function expectSameSet(model: OpenTabsModel): void {
  expect([...model.tabs].sort()).toEqual([...model.lru].sort());
}

describe("emptyModel", () => {
  it("starts with no tabs and no recency", () => {
    const model = emptyModel();
    expect(model.tabs).toEqual([]);
    expect(model.lru).toEqual([]);
  });
});

describe("openInSet — add-new", () => {
  it("appends an absent id to display order and marks it most-recently-active", () => {
    const model = openInSet(emptyModel(), "a");
    expect(model.tabs).toEqual(["a"]);
    expect(model.lru).toEqual(["a"]);
  });

  it("appends successive new ids in open order, each becoming most recent", () => {
    let model = emptyModel();
    model = openInSet(model, "a");
    model = openInSet(model, "b");
    model = openInSet(model, "c");
    expect(model.tabs).toEqual(["a", "b", "c"]);
    expect(model.lru).toEqual(["a", "b", "c"]);
    expectSameSet(model);
  });
});

describe("openInSet — add-existing bumps recency without reordering display", () => {
  it("leaves tabs order unchanged but moves the id to the most-recent end of lru", () => {
    let model = emptyModel();
    model = openInSet(model, "a");
    model = openInSet(model, "b");
    model = openInSet(model, "c");
    const bumped = openInSet(model, "a");
    expect(bumped.tabs).toEqual(["a", "b", "c"]);
    expect(bumped.lru).toEqual(["b", "c", "a"]);
    expectSameSet(bumped);
  });

  it("bumping the already-most-recent id is a no-op for both orders", () => {
    let model = emptyModel();
    model = openInSet(model, "a");
    model = openInSet(model, "b");
    const bumped = openInSet(model, "b");
    expect(bumped.tabs).toEqual(["a", "b"]);
    expect(bumped.lru).toEqual(["a", "b"]);
  });
});

describe("openInSet — evict-at-cap", () => {
  function fullModel(): OpenTabsModel {
    let model = emptyModel();
    for (const id of ["a", "b", "c", "d", "e", "f"]) {
      model = openInSet(model, id);
    }
    return model;
  }

  it("evicts the least-recently-active id from both orders before adding the new id", () => {
    const model = fullModel();
    expect(model.tabs).toHaveLength(MAX_OPEN_TABS);
    const next = openInSet(model, "g");
    expect(next.tabs).toHaveLength(MAX_OPEN_TABS);
    expect(next.lru).toHaveLength(MAX_OPEN_TABS);
    // "a" was lru[0] (least recently active) → evicted from both.
    expect(next.tabs).not.toContain("a");
    expect(next.lru).not.toContain("a");
    expect(next.tabs).toContain("g");
    expect(next.lru).toContain("g");
    expectSameSet(next);
  });

  it("evicts in display position, leaving survivor display order otherwise intact", () => {
    const model = fullModel();
    const next = openInSet(model, "g");
    expect(next.tabs).toEqual(["b", "c", "d", "e", "f", "g"]);
    expect(next.lru).toEqual(["b", "c", "d", "e", "f", "g"]);
  });

  it("evicts the least-recently-active id, which need not be the first-opened", () => {
    let model = fullModel();
    // Bump "a" so it is no longer the eviction victim; "b" becomes lru[0].
    model = openInSet(model, "a");
    expect(model.lru).toEqual(["b", "c", "d", "e", "f", "a"]);
    const next = openInSet(model, "g");
    expect(next.tabs).not.toContain("b");
    expect(next.lru).not.toContain("b");
    expect(next.tabs).toContain("a");
    expect(next.tabs).toContain("g");
    expect(next.tabs).toHaveLength(MAX_OPEN_TABS);
    expectSameSet(next);
  });

  it("never evicts the id being activated even when it is already at cap (bump path)", () => {
    const model = fullModel();
    // Opening an id already at cap must not evict anything.
    const next = openInSet(model, "a");
    expect(next.tabs).toHaveLength(MAX_OPEN_TABS);
    expect(next.tabs).toContain("a");
    expect(next.tabs).toEqual(["a", "b", "c", "d", "e", "f"]);
  });
});

describe("openInSet — size invariant over a long open sequence", () => {
  it("never lets tabs exceed MAX_OPEN_TABS across many opens", () => {
    let model = emptyModel();
    const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
    for (const id of ids) {
      model = openInSet(model, id);
      expect(model.tabs.length).toBeLessThanOrEqual(MAX_OPEN_TABS);
      expect(model.lru.length).toBeLessThanOrEqual(MAX_OPEN_TABS);
      expectSameSet(model);
    }
    // The final set must be the six most-recently-opened ids in open order.
    expect(model.tabs).toEqual([
      "id-44",
      "id-45",
      "id-46",
      "id-47",
      "id-48",
      "id-49",
    ]);
  });
});

describe("reconcile — drops ids absent from the live set", () => {
  it("removes missing ids from both orders, preserving survivor order", () => {
    let model = emptyModel();
    for (const id of ["a", "b", "c", "d"]) {
      model = openInSet(model, id);
    }
    // Recency differs from display order to prove both are filtered.
    model = openInSet(model, "b");
    expect(model.lru).toEqual(["a", "c", "d", "b"]);
    const next = reconcile(model, new Set(["a", "c"]));
    expect(next.tabs).toEqual(["a", "c"]);
    expect(next.lru).toEqual(["a", "c"]);
    expectSameSet(next);
  });

  it("returns an empty-equivalent model when nothing is live", () => {
    let model = emptyModel();
    model = openInSet(model, "a");
    model = openInSet(model, "b");
    const next = reconcile(model, new Set<string>());
    expect(next.tabs).toEqual([]);
    expect(next.lru).toEqual([]);
  });

  it("is a no-op when every id is still live", () => {
    let model = emptyModel();
    model = openInSet(model, "a");
    model = openInSet(model, "b");
    const next = reconcile(model, new Set(["a", "b"]));
    expect(next.tabs).toEqual(["a", "b"]);
    expect(next.lru).toEqual(["a", "b"]);
  });

  it("ignores live ids that are not in the set", () => {
    let model = emptyModel();
    model = openInSet(model, "a");
    const next = reconcile(model, new Set(["a", "x", "y"]));
    expect(next.tabs).toEqual(["a"]);
    expect(next.lru).toEqual(["a"]);
  });
});

describe("closeTab — removes from both orders", () => {
  it("removes the id from both display and recency order", () => {
    let model = emptyModel();
    for (const id of ["a", "b", "c"]) {
      model = openInSet(model, id);
    }
    const next = closeTab(model, "b");
    expect(next.tabs).toEqual(["a", "c"]);
    expect(next.lru).toEqual(["a", "c"]);
    expectSameSet(next);
  });

  it("is a no-op when the id is not present", () => {
    let model = emptyModel();
    model = openInSet(model, "a");
    model = openInSet(model, "b");
    const next = closeTab(model, "z");
    expect(next.tabs).toEqual(["a", "b"]);
    expect(next.lru).toEqual(["a", "b"]);
  });

  it("can empty the set when the last id is closed", () => {
    let model = emptyModel();
    model = openInSet(model, "a");
    const next = closeTab(model, "a");
    expect(next.tabs).toEqual([]);
    expect(next.lru).toEqual([]);
  });
});

describe("purity — inputs are never mutated", () => {
  it("openInSet (add-new) leaves the input model untouched", () => {
    const model = openInSet(openInSet(emptyModel(), "a"), "b");
    const before = snapshot(model);
    openInSet(model, "c");
    expect(snapshot(model)).toEqual(before);
  });

  it("openInSet (bump) leaves the input model untouched", () => {
    const model = openInSet(openInSet(emptyModel(), "a"), "b");
    const before = snapshot(model);
    openInSet(model, "a");
    expect(snapshot(model)).toEqual(before);
  });

  it("openInSet (evict) leaves the input model untouched", () => {
    let model = emptyModel();
    for (const id of ["a", "b", "c", "d", "e", "f"]) {
      model = openInSet(model, id);
    }
    const before = snapshot(model);
    openInSet(model, "g");
    expect(snapshot(model)).toEqual(before);
  });

  it("closeTab leaves the input model untouched", () => {
    const model = openInSet(openInSet(emptyModel(), "a"), "b");
    const before = snapshot(model);
    closeTab(model, "a");
    expect(snapshot(model)).toEqual(before);
  });

  it("reconcile leaves the input model untouched", () => {
    const model = openInSet(openInSet(emptyModel(), "a"), "b");
    const before = snapshot(model);
    reconcile(model, new Set(["a"]));
    expect(snapshot(model)).toEqual(before);
  });

  it("returns fresh array references, not the input arrays", () => {
    const model = openInSet(emptyModel(), "a");
    const next = openInSet(model, "b");
    expect(next.tabs).not.toBe(model.tabs);
    expect(next.lru).not.toBe(model.lru);
  });
});
