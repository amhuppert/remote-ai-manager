import { describe, it, expect } from "vitest";
import { acquireSessionLock, isSessionBusy } from "../lock";

describe("lock", () => {
  const project = "/tmp/test-project";

  it("isSessionBusy returns false when no lock held", () => {
    expect(isSessionBusy(project, "no-lock")).toBe(false);
  });

  it("acquireSessionLock succeeds and marks session as busy", () => {
    const release = acquireSessionLock(project, "test-lock-1");
    expect(isSessionBusy(project, "test-lock-1")).toBe(true);
    release();
    expect(isSessionBusy(project, "test-lock-1")).toBe(false);
  });

  it("acquireSessionLock throws when session is already busy", () => {
    const release = acquireSessionLock(project, "test-lock-2");
    expect(() => acquireSessionLock(project, "test-lock-2")).toThrow(
      "Session is busy",
    );
    release();
  });

  it("different sessions have independent locks", () => {
    const release1 = acquireSessionLock(project, "test-lock-a");
    const release2 = acquireSessionLock(project, "test-lock-b");

    expect(isSessionBusy(project, "test-lock-a")).toBe(true);
    expect(isSessionBusy(project, "test-lock-b")).toBe(true);

    release1();
    expect(isSessionBusy(project, "test-lock-a")).toBe(false);
    expect(isSessionBusy(project, "test-lock-b")).toBe(true);

    release2();
  });

  it("same session name in different projects are independent", () => {
    const release1 = acquireSessionLock("/project-a", "same-name");
    const release2 = acquireSessionLock("/project-b", "same-name");

    expect(isSessionBusy("/project-a", "same-name")).toBe(true);
    expect(isSessionBusy("/project-b", "same-name")).toBe(true);

    release1();
    release2();
  });

  it("release is idempotent (no error on double release)", () => {
    const release = acquireSessionLock(project, "test-lock-3");
    release();
    // Second release should not throw
    expect(() => release()).not.toThrow();
  });
});
