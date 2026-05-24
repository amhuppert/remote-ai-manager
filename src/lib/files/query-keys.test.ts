import { describe, it, expect } from "vitest";
import { fileKeys } from "./query-keys";

describe("fileKeys", () => {
  it("list and sessionList produce distinct cache keys for different sessions", () => {
    const a = fileKeys.sessionList("proj", "session-a");
    const b = fileKeys.sessionList("proj", "session-b");
    expect(a).not.toEqual(b);
  });

  it("sessionList differs from list under the same project name", () => {
    const project = fileKeys.list("proj");
    const session = fileKeys.sessionList("proj", "main");
    expect(project).not.toEqual(session);
  });

  it("sessionList is deterministic for the same inputs", () => {
    const a = fileKeys.sessionList("proj", "feature-x");
    const b = fileKeys.sessionList("proj", "feature-x");
    expect(a).toEqual(b);
  });
});
