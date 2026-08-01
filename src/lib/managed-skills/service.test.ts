import { afterEach, describe, expect, it, vi } from "vitest";

import type { ManagedSkillBundle } from "./schemas";

const bundle: ManagedSkillBundle = {
  id: "command-center",
  version: "2.23.1",
  digest: "0123456789abcdef",
  root: "/config/agent-bundles/command-center/0123456789abcdef",
  skillsRoot: "/config/agent-bundles/command-center/0123456789abcdef/skills",
  skillNames: ["agent-context", "cc-cli"],
};

afterEach(async () => {
  const service = await import("./service");
  service.setPublishedManagedSkillBundle(null);
  vi.resetModules();
});

describe("managed skill bundle registry", () => {
  it("survives module re-evaluation across Next.js server graphs", async () => {
    const startupGraph = await import("./service");
    startupGraph.setPublishedManagedSkillBundle(bundle);

    vi.resetModules();
    const launchGraph = await import("./service");

    expect(launchGraph.getPublishedManagedSkillBundle()).toEqual(bundle);
  });
});
