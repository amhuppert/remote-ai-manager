import { describe, expect, it } from "vitest";
import {
  clampAmbientRows,
  formatElapsed,
  partitionActiveWork,
  type ActiveWorkItem,
} from "./active-work";

function makeItem(overrides: Partial<ActiveWorkItem> = {}): ActiveWorkItem {
  return {
    id: "job-1",
    kind: "job",
    title: "Merge auth-fix",
    projectName: "command-center",
    sessionName: "session-12",
    phase: "Validating…",
    href: "/projects/command-center/session-12",
    startedAt: "2026-07-11T10:00:00.000Z",
    ...overrides,
  };
}

describe("partitionActiveWork", () => {
  it("splits needs-action items from running items", () => {
    const running = makeItem({ id: "a" });
    const actionable = makeItem({
      id: "b",
      phase: "Ready to land",
      needsAction: { primary: { label: "Land", kind: "land" } },
    });

    const result = partitionActiveWork([running, actionable]);

    expect(result.needsAction.map((i) => i.id)).toEqual(["b"]);
    expect(result.running.map((i) => i.id)).toEqual(["a"]);
  });

  it("sorts each group oldest-first so rows stay stable as new work arrives", () => {
    const older = makeItem({ id: "old", startedAt: "2026-07-11T09:00:00Z" });
    const newer = makeItem({ id: "new", startedAt: "2026-07-11T11:00:00Z" });
    const olderAction = makeItem({
      id: "old-action",
      startedAt: "2026-07-11T08:00:00Z",
      needsAction: { primary: { label: "Resolve", kind: "resolve" } },
    });
    const newerAction = makeItem({
      id: "new-action",
      startedAt: "2026-07-11T10:30:00Z",
      needsAction: { primary: { label: "Land", kind: "land" } },
    });

    const result = partitionActiveWork([
      newer,
      newerAction,
      older,
      olderAction,
    ]);

    expect(result.needsAction.map((i) => i.id)).toEqual([
      "old-action",
      "new-action",
    ]);
    expect(result.running.map((i) => i.id)).toEqual(["old", "new"]);
  });
});

describe("clampAmbientRows", () => {
  const partition = (ids: {
    needsAction: string[];
    running: string[];
  }): ReturnType<typeof partitionActiveWork> => ({
    needsAction: ids.needsAction.map((id) =>
      makeItem({
        id,
        needsAction: { primary: { label: "Land", kind: "land" } },
      }),
    ),
    running: ids.running.map((id) => makeItem({ id })),
  });

  it("returns everything when at or under the cap", () => {
    const result = clampAmbientRows(
      partition({ needsAction: ["a"], running: ["b", "c"] }),
    );
    expect(result.visible.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(result.hiddenCount).toBe(0);
  });

  it("caps at three rows, needs-action taking precedence over running", () => {
    const result = clampAmbientRows(
      partition({ needsAction: ["a", "b"], running: ["c", "d", "e"] }),
    );
    expect(result.visible.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(result.hiddenCount).toBe(2);
  });

  it("shows only needs-action rows when they alone exceed the cap", () => {
    const result = clampAmbientRows(
      partition({ needsAction: ["a", "b", "c", "d"], running: ["e"] }),
    );
    expect(result.visible.map((i) => i.id)).toEqual(["a", "b", "c"]);
    expect(result.hiddenCount).toBe(2);
  });
});

describe("formatElapsed", () => {
  const now = Date.parse("2026-07-11T12:00:00Z");

  it("formats sub-minute as now", () => {
    expect(formatElapsed("2026-07-11T11:59:40Z", now)).toBe("now");
  });

  it("formats minutes, hours, and days compactly", () => {
    expect(formatElapsed("2026-07-11T11:35:00Z", now)).toBe("25m");
    expect(formatElapsed("2026-07-11T09:00:00Z", now)).toBe("3h");
    expect(formatElapsed("2026-07-09T09:00:00Z", now)).toBe("2d");
  });

  it("returns empty string for an unparseable timestamp", () => {
    expect(formatElapsed("not-a-date", now)).toBe("");
  });
});
