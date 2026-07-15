import { describe, expect, it } from "vitest";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  COLLABORATION_BACKEND_PAIR,
  buildCollaborationLaneSeeds,
  oppositeCollaborationBackend,
  primaryLaneSeedRef,
} from "./backend-pair";

describe("COLLABORATION_BACKEND_PAIR", () => {
  it("is the ordered Claude×Codex pair (claude first, codex second)", () => {
    expect(COLLABORATION_BACKEND_PAIR).toEqual(["claude", "codex"]);
  });

  it("uses each backend id as its own lane id", () => {
    // laneId === backend is the rule the seed builder and lane routing rely on.
    for (const backend of COLLABORATION_BACKEND_PAIR) {
      expect<AgentBackendId>(backend).toBe(backend);
    }
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

  it("emits one lane per pair member in pair order (claude then codex)", () => {
    const seeds = buildCollaborationLaneSeeds({
      ...base,
      seedRefFor: () => null,
    });
    expect(seeds.map((s) => s.laneId)).toEqual(["claude", "codex"]);
    expect(seeds.map((s) => s.backend)).toEqual(["claude", "codex"]);
  });

  it("carries the supplied workflowId, write capability, policy, and timestamp onto every lane", () => {
    const seeds = buildCollaborationLaneSeeds({
      ...base,
      seedRefFor: () => null,
    });
    for (const seed of seeds) {
      expect(seed.workflowId).toBe("wf-1");
      expect(seed.writeCapability).toBe("write_capable");
      expect(seed.policy).toEqual({ continuityEnabled: true });
      expect(seed.lastUsedAt).toBe("2026-07-13T00:00:00.000Z");
      expect(seed.metrics).toEqual({ rotateBeforeNextTurn: false });
    }
  });

  it("seeds each lane's ref from seedRefFor, called once per backend", () => {
    const seen: AgentBackendId[] = [];
    const seeds = buildCollaborationLaneSeeds({
      ...base,
      seedRefFor: (backend) => {
        seen.push(backend);
        return backend === "claude" ? "sess-1" : null;
      },
    });
    expect(seen).toEqual(["claude", "codex"]);
    expect(seeds.find((s) => s.backend === "claude")?.ref).toBe("sess-1");
    expect(seeds.find((s) => s.backend === "codex")?.ref).toBeNull();
  });

  it("supports the disabled-continuity variant (fresh lanes, no ref)", () => {
    const seeds = buildCollaborationLaneSeeds({
      ...base,
      policy: { continuityEnabled: false },
      seedRefFor: () => null,
    });
    for (const seed of seeds) {
      expect(seed.policy).toEqual({ continuityEnabled: false });
      expect(seed.ref).toBeNull();
    }
  });
});

describe("primaryLaneSeedRef", () => {
  it("seeds the primary lane's ref when the prior ref belongs to the primary backend", () => {
    expect(
      primaryLaneSeedRef("claude", "claude", {
        backend: "claude",
        ref: "sess-1",
      }),
    ).toBe("sess-1");
    expect(
      primaryLaneSeedRef("codex", "codex", { backend: "codex", ref: "th-1" }),
    ).toBe("th-1");
  });

  it("does not seed the non-primary lane", () => {
    // Prior ref is claude but the query is for the codex lane → no seed.
    expect(
      primaryLaneSeedRef("codex", "claude", {
        backend: "claude",
        ref: "sess-1",
      }),
    ).toBeNull();
  });

  it("does not seed when the prior ref's backend differs from the primary", () => {
    // Primary is claude, prior ref is codex → mismatch, ignored.
    expect(
      primaryLaneSeedRef("claude", "claude", { backend: "codex", ref: "th-1" }),
    ).toBeNull();
  });

  it("returns null when no prior ref is supplied", () => {
    expect(primaryLaneSeedRef("claude", "claude", null)).toBeNull();
    expect(primaryLaneSeedRef("claude", "claude", undefined)).toBeNull();
  });
});
