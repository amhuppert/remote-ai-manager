import { describe, expect, it } from "vitest";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  COLLABORATION_DEFAULT_PARTNER,
  COLLABORATION_FLOW_AGENTS,
  COLLABORATION_SUPPORTED_PAIRS,
  agentOneLaneSeedRef,
  buildCollaborationLaneSeeds,
  collaborationPairRefusal,
  defaultCollaborationPartner,
  resolveGraphCollaborationBackends,
} from "./backend-pair";
import { collaborationAgentSchema } from "./types";

describe("COLLABORATION_DEFAULT_PARTNER", () => {
  it("names a default partner for every collaboration agent", () => {
    expect(Object.keys(COLLABORATION_DEFAULT_PARTNER).sort()).toEqual(
      [...collaborationAgentSchema.options].sort(),
    );
  });

  it("keeps the historical Claude/Codex suggestion and partners Cursor with Claude", () => {
    expect(defaultCollaborationPartner("claude")).toBe("codex");
    expect(defaultCollaborationPartner("codex")).toBe("claude");
    expect(defaultCollaborationPartner("cursor")).toBe("claude");
  });

  it("never suggests a same-backend pair by default", () => {
    for (const backend of collaborationAgentSchema.options) {
      expect(defaultCollaborationPartner(backend)).not.toBe(backend);
    }
  });
});

describe("COLLABORATION_SUPPORTED_PAIRS", () => {
  // The matrix is written out explicitly so adding a participant to the enum
  // is a conscious decision about every position it may take, not an
  // accident of the enum growing.
  it("admits every ordered pair of collaboration agents, including same-backend pairs", () => {
    const expected = collaborationAgentSchema.options
      .flatMap((one) =>
        collaborationAgentSchema.options.map((two) => `${one}/${two}`),
      )
      .sort();
    const actual = COLLABORATION_SUPPORTED_PAIRS.map(
      ([one, two]) => `${one}/${two}`,
    ).sort();
    expect(actual).toEqual(expected);
    expect(new Set(actual).size).toBe(actual.length);
  });

  it.each([
    ["cursor", "claude"],
    ["cursor", "codex"],
    ["claude", "cursor"],
    ["codex", "cursor"],
    ["cursor", "cursor"],
  ] as const)("accepts the %s/%s pair", (one, two) => {
    expect(collaborationPairRefusal(one, two)).toBeNull();
  });
});

describe("resolveGraphCollaborationBackends", () => {
  it("derives agent_one as the configured second agent's default partner", () => {
    expect(resolveGraphCollaborationBackends("codex")).toEqual({
      agent_one: "claude",
      agent_two: "codex",
    });
    expect(resolveGraphCollaborationBackends("cursor")).toEqual({
      agent_one: "claude",
      agent_two: "cursor",
    });
    expect(resolveGraphCollaborationBackends("claude")).toEqual({
      agent_one: "codex",
      agent_two: "claude",
    });
  });

  it("refuses a registered backend outside the collaboration policy loudly, naming the lane", () => {
    const unknown = "nonexistent" as AgentBackendId;
    expect(() => resolveGraphCollaborationBackends(unknown)).toThrow(
      /agent_two/,
    );
  });
});

describe("COLLABORATION_FLOW_AGENTS", () => {
  it("is the ordered flow-agent pair (agent_one first, agent_two second)", () => {
    expect(COLLABORATION_FLOW_AGENTS).toEqual(["agent_one", "agent_two"]);
  });
});

describe("buildCollaborationLaneSeeds", () => {
  const base = {
    workflowId: "wf-1",
    writeCapability: "write_capable" as const,
    policy: { continuityEnabled: true },
    lastUsedAt: "2026-07-13T00:00:00.000Z",
  };

  it("keys each lane by its flow agent, in flow-agent order", () => {
    const seeds = buildCollaborationLaneSeeds({
      ...base,
      backendFor: (agent) => (agent === "agent_one" ? "claude" : "codex"),
      seedRefFor: () => null,
    });
    expect(seeds.map((s) => s.laneId)).toEqual(["agent_one", "agent_two"]);
    expect(seeds.map((s) => s.backend)).toEqual(["claude", "codex"]);
  });

  it("keeps two distinct lanes when both flow agents run the same backend", () => {
    const seeds = buildCollaborationLaneSeeds({
      ...base,
      backendFor: () => "claude",
      seedRefFor: () => null,
    });
    expect(seeds.map((s) => s.laneId)).toEqual(["agent_one", "agent_two"]);
    expect(seeds.map((s) => s.backend)).toEqual(["claude", "claude"]);
  });

  it("carries the supplied workflowId, write capability, policy, and timestamp onto every lane", () => {
    const seeds = buildCollaborationLaneSeeds({
      ...base,
      backendFor: () => "codex",
      seedRefFor: () => null,
    });
    for (const seed of seeds) {
      expect(seed.workflowId).toBe("wf-1");
      expect(seed.writeCapability).toBe("write_capable");
      expect(seed.policy).toEqual({ continuityEnabled: true });
      expect(seed.lastUsedAt).toBe("2026-07-13T00:00:00.000Z");
      expect(seed.metrics).toEqual({});
    }
  });

  it("seeds each lane's ref from seedRefFor, called once per flow agent", () => {
    const seen: string[] = [];
    const seeds = buildCollaborationLaneSeeds({
      ...base,
      backendFor: (agent) => (agent === "agent_one" ? "claude" : "codex"),
      seedRefFor: (agent) => {
        seen.push(agent);
        return agent === "agent_one" ? "sess-1" : null;
      },
    });
    expect(seen).toEqual(["agent_one", "agent_two"]);
    expect(seeds.find((s) => s.laneId === "agent_one")?.ref).toBe("sess-1");
    expect(seeds.find((s) => s.laneId === "agent_two")?.ref).toBeNull();
  });

  it("supports the disabled-continuity variant (fresh lanes, no ref)", () => {
    const seeds = buildCollaborationLaneSeeds({
      ...base,
      policy: { continuityEnabled: false },
      backendFor: () => "claude",
      seedRefFor: () => null,
    });
    for (const seed of seeds) {
      expect(seed.policy).toEqual({ continuityEnabled: false });
      expect(seed.ref).toBeNull();
    }
  });
});

describe("agentOneLaneSeedRef", () => {
  it("seeds agent_one's ref when the prior ref belongs to its backend", () => {
    const claudeRef: { backend: AgentBackendId; ref: string } = {
      backend: "claude",
      ref: "sess-1",
    };
    expect(agentOneLaneSeedRef("claude", claudeRef)).toBe("sess-1");
    expect(
      agentOneLaneSeedRef("codex", { backend: "codex", ref: "th-1" }),
    ).toBe("th-1");
  });

  it("does not seed when the prior ref's backend differs from agent_one's", () => {
    expect(
      agentOneLaneSeedRef("claude", { backend: "codex", ref: "th-1" }),
    ).toBeNull();
  });

  it("returns null when no prior ref is supplied", () => {
    expect(agentOneLaneSeedRef("claude", null)).toBeNull();
    expect(agentOneLaneSeedRef("claude", undefined)).toBeNull();
  });
});
