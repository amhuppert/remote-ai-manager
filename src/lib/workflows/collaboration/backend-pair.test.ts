import { describe, expect, it } from "vitest";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  COLLABORATION_BACKEND_PAIR,
  COLLABORATION_FLOW_AGENTS,
  agentOneLaneSeedRef,
  buildCollaborationLaneSeeds,
  oppositeCollaborationBackend,
} from "./backend-pair";

describe("COLLABORATION_BACKEND_PAIR", () => {
  it("is the ordered Claude×Codex pair (claude first, codex second)", () => {
    expect(COLLABORATION_BACKEND_PAIR).toEqual(["claude", "codex"]);
  });
});

describe("COLLABORATION_FLOW_AGENTS", () => {
  it("is the ordered flow-agent pair (agent_one first, agent_two second)", () => {
    expect(COLLABORATION_FLOW_AGENTS).toEqual(["agent_one", "agent_two"]);
  });
});

describe("oppositeCollaborationBackend", () => {
  it("maps claude → codex", () => {
    expect(oppositeCollaborationBackend("claude")).toBe("codex");
  });

  it("maps codex → claude", () => {
    expect(oppositeCollaborationBackend("codex")).toBe("claude");
  });

  it("is an involution over the pair (opposite of opposite is identity)", () => {
    for (const backend of COLLABORATION_BACKEND_PAIR) {
      expect(
        oppositeCollaborationBackend(oppositeCollaborationBackend(backend)),
      ).toBe(backend);
    }
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
