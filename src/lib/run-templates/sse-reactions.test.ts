import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { FakeEventSource } from "@/lib/shared/testing/fake-event-source";
import { runTemplateKeys } from "./query-keys";
import { registerRunTemplateSseReactions } from "./sse-reactions";

const keys = {
  alphaList: runTemplateKeys.list("alpha"),
  alphaProject: runTemplateKeys.detail("alpha", "project", "review"),
  alphaOther: runTemplateKeys.detail("alpha", "project", "docs"),
  alphaGlobal: runTemplateKeys.detail("alpha", "global", "review"),
  betaList: runTemplateKeys.list("beta"),
  betaGlobal: runTemplateKeys.detail("beta", "global", "review"),
};

function setup() {
  const fake = new FakeEventSource("/api/events");
  const queryClient = new QueryClient();
  for (const key of Object.values(keys)) queryClient.setQueryData(key, {});
  registerRunTemplateSseReactions(fake as unknown as EventSource, {
    queryClient,
  });
  const stale = () =>
    Object.fromEntries(
      Object.entries(keys).map(([name, key]) => [
        name,
        queryClient.getQueryState(key)?.isInvalidated ?? false,
      ]),
    );
  return { fake, stale };
}

describe("run template SSE reactions", () => {
  it("refreshes every project's template reads when a global template changes", () => {
    const { fake, stale } = setup();
    fake.emit("run-template-changed", {
      type: "run-template-changed",
      scope: "global",
      id: "review",
      revision: 3,
      action: "updated",
    });
    expect(stale()).toEqual({
      alphaList: true,
      alphaProject: true,
      alphaOther: true,
      alphaGlobal: true,
      betaList: true,
      betaGlobal: true,
    });
  });

  it("refreshes only the owning project's list and the changed template when a project template changes", () => {
    const { fake, stale } = setup();
    fake.emit("run-template-changed", {
      type: "run-template-changed",
      scope: "project",
      projectPath: "/repos/alpha",
      id: "review",
      revision: 2,
      action: "created",
    });
    expect(stale()).toEqual({
      alphaList: true,
      alphaProject: true,
      alphaOther: false,
      alphaGlobal: false,
      betaList: false,
      betaGlobal: false,
    });
  });

  it("refreshes everything when a project template's path names no project", () => {
    const { fake, stale } = setup();
    fake.emit("run-template-changed", {
      type: "run-template-changed",
      scope: "project",
      projectPath: "/",
      id: "review",
      revision: 2,
      action: "deleted",
    });
    expect(Object.values(stale()).every((invalidated) => invalidated)).toBe(
      true,
    );
  });

  it("ignores a malformed frame", () => {
    const { fake, stale } = setup();
    fake.emit("run-template-changed", {
      type: "run-template-changed",
      scope: "project",
      id: "review",
    });
    expect(Object.values(stale()).some((invalidated) => invalidated)).toBe(
      false,
    );
  });
});
