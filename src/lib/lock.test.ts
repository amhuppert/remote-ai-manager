import { describe, it, expect } from "vitest";
import {
  acquireSessionLock,
  isSessionBusy,
  acquireProjectLock,
  isProjectLocked,
  acquireConversationLock,
  isConversationBusy,
} from "./lock";

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

describe("project lock", () => {
  const projectA = "/tmp/project-a";
  const projectB = "/tmp/project-b";

  it("acquireProjectLock succeeds when no lock held, returns release function", () => {
    const release = acquireProjectLock(projectA);
    expect(typeof release).toBe("function");
    release();
  });

  it("after release, lock can be re-acquired", () => {
    const release1 = acquireProjectLock(projectA);
    release1();

    // Should not throw — lock was released
    const release2 = acquireProjectLock(projectA);
    expect(isProjectLocked(projectA)).toBe(true);
    release2();
  });

  it("acquireProjectLock throws when lock already held for same project", () => {
    const release = acquireProjectLock(projectA);
    expect(() => acquireProjectLock(projectA)).toThrow();
    release();
  });

  it("two different projects can hold locks concurrently", () => {
    const releaseA = acquireProjectLock(projectA);
    const releaseB = acquireProjectLock(projectB);

    expect(isProjectLocked(projectA)).toBe(true);
    expect(isProjectLocked(projectB)).toBe(true);

    releaseA();
    expect(isProjectLocked(projectA)).toBe(false);
    expect(isProjectLocked(projectB)).toBe(true);

    releaseB();
  });

  it("project locks are independent from session locks", () => {
    const projectRelease = acquireProjectLock(projectA);
    const sessionRelease = acquireSessionLock(projectA, "some-session");

    // Both locks held simultaneously
    expect(isProjectLocked(projectA)).toBe(true);
    expect(isSessionBusy(projectA, "some-session")).toBe(true);

    // Releasing project lock does not affect session lock
    projectRelease();
    expect(isProjectLocked(projectA)).toBe(false);
    expect(isSessionBusy(projectA, "some-session")).toBe(true);

    sessionRelease();
    expect(isSessionBusy(projectA, "some-session")).toBe(false);
  });

  it("isProjectLocked returns correct state", () => {
    expect(isProjectLocked(projectA)).toBe(false);

    const release = acquireProjectLock(projectA);
    expect(isProjectLocked(projectA)).toBe(true);

    release();
    expect(isProjectLocked(projectA)).toBe(false);
  });

  it("release is idempotent (no error on double release)", () => {
    const release = acquireProjectLock(projectA);
    release();
    expect(() => release()).not.toThrow();
    expect(isProjectLocked(projectA)).toBe(false);
  });
});

describe("conversation lock", () => {
  const project = "/tmp/test-project-conv";
  const session = "conv-session";

  it("isConversationBusy returns false when no lock held", () => {
    expect(isConversationBusy(project, session, "conv-1")).toBe(false);
  });

  it("acquireConversationLock succeeds and marks conversation as busy", () => {
    const release = acquireConversationLock(project, session, "conv-a1");
    expect(isConversationBusy(project, session, "conv-a1")).toBe(true);
    release();
    expect(isConversationBusy(project, session, "conv-a1")).toBe(false);
  });

  it("acquireConversationLock throws when conversation is already busy", () => {
    const release = acquireConversationLock(project, session, "conv-a2");
    expect(() => acquireConversationLock(project, session, "conv-a2")).toThrow(
      "Conversation is busy",
    );
    release();
  });

  it("different conversations in same session can hold locks concurrently", () => {
    const release1 = acquireConversationLock(project, session, "conv-x");
    const release2 = acquireConversationLock(project, session, "conv-y");

    expect(isConversationBusy(project, session, "conv-x")).toBe(true);
    expect(isConversationBusy(project, session, "conv-y")).toBe(true);

    release1();
    expect(isConversationBusy(project, session, "conv-x")).toBe(false);
    expect(isConversationBusy(project, session, "conv-y")).toBe(true);

    release2();
  });

  it("conversation locks are independent from session locks", () => {
    const sessionRelease = acquireSessionLock(project, session);
    const convRelease = acquireConversationLock(project, session, "conv-z");

    expect(isSessionBusy(project, session)).toBe(true);
    expect(isConversationBusy(project, session, "conv-z")).toBe(true);

    sessionRelease();
    expect(isSessionBusy(project, session)).toBe(false);
    expect(isConversationBusy(project, session, "conv-z")).toBe(true);

    convRelease();
  });

  it("release is idempotent (no error on double release)", () => {
    const release = acquireConversationLock(project, session, "conv-idem");
    release();
    expect(() => release()).not.toThrow();
  });
});
