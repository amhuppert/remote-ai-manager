import { describe, expect, it } from "vitest";

import { contextArtifactKeys, type ContextArtifactTarget } from "./query-keys";

const sessionTarget: ContextArtifactTarget = {
  scope: "session",
  projectName: "proj",
  sessionName: "sess",
  conversationId: "conv-1",
};

const projectTarget: ContextArtifactTarget = {
  scope: "project",
  projectName: "proj",
  conversationId: "conv-1",
};

describe("contextArtifactKeys", () => {
  it("roots every key under the domain prefix", () => {
    expect(contextArtifactKeys.all).toEqual(["context-artifacts"]);
    for (const key of [
      contextArtifactKeys.conversation(sessionTarget),
      contextArtifactKeys.conversation(projectTarget),
      contextArtifactKeys.list(sessionTarget),
      contextArtifactKeys.list(projectTarget),
      contextArtifactKeys.detail(sessionTarget, "a-1"),
      contextArtifactKeys.detail(projectTarget, "a-1"),
    ]) {
      expect(key[0]).toBe("context-artifacts");
    }
  });

  it("builds session list keys carrying scope, project, session, and conversation identity", () => {
    expect(contextArtifactKeys.list(sessionTarget)).toEqual([
      "context-artifacts",
      "session",
      "proj",
      "sess",
      "conv-1",
      "list",
    ]);
  });

  it("builds project list keys without a session segment", () => {
    expect(contextArtifactKeys.list(projectTarget)).toEqual([
      "context-artifacts",
      "project",
      "proj",
      "conv-1",
      "list",
    ]);
  });

  it("keeps session and project keys distinct for identical names", () => {
    expect(contextArtifactKeys.list(sessionTarget)).not.toEqual(
      contextArtifactKeys.list(projectTarget),
    );
  });

  it("extends the conversation prefix for both list and detail keys", () => {
    for (const target of [sessionTarget, projectTarget]) {
      const prefix = contextArtifactKeys.conversation(target);
      expect(contextArtifactKeys.list(target).slice(0, prefix.length)).toEqual([
        ...prefix,
      ]);
      expect(
        contextArtifactKeys.detail(target, "a-1").slice(0, prefix.length),
      ).toEqual([...prefix]);
    }
  });

  it("keys detail by artifact id", () => {
    expect(contextArtifactKeys.detail(sessionTarget, "a-1")).toEqual([
      "context-artifacts",
      "session",
      "proj",
      "sess",
      "conv-1",
      "detail",
      "a-1",
    ]);
    expect(contextArtifactKeys.detail(sessionTarget, "a-1")).not.toEqual(
      contextArtifactKeys.detail(sessionTarget, "a-2"),
    );
  });
});
