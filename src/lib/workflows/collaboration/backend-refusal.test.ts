import { describe, expect, it } from "vitest";
import {
  getBackendCatalogEntry,
  type BackendCatalogEntry,
} from "@/lib/agent-backends/catalog";
import type { AgentBackendId } from "@/lib/shared/schemas";
import {
  collaborationAgentRefusal,
  collaborationAgentSchema,
  collaborationBackendAdmission,
  collaborationBackendRefusal,
  collaborationLaneDispatch,
  collaborationLaneFacet,
} from "./types";

function entryWithFacets(
  base: BackendCatalogEntry,
  facets: BackendCatalogEntry["facets"],
): BackendCatalogEntry {
  return { ...base, facets };
}

describe("collaboration participation policy", () => {
  it("admits Claude, Codex, and Cursor as collaboration agents", () => {
    expect([...collaborationAgentSchema.options].sort()).toEqual([
      "claude",
      "codex",
      "cursor",
    ]);
  });

  it("dispatches Claude lanes as conversation turns and every other lane as a task run", () => {
    expect(collaborationLaneDispatch("claude")).toBe("conversation_turn");
    expect(collaborationLaneDispatch("codex")).toBe("task_run");
    expect(collaborationLaneDispatch("cursor")).toBe("task_run");
    expect(collaborationLaneFacet("claude")).toBe("conversation");
    expect(collaborationLaneFacet("codex")).toBe("tasks");
    expect(collaborationLaneFacet("cursor")).toBe("tasks");
  });
});

describe("collaborationBackendRefusal", () => {
  it("permits every registered collaboration agent with its lane facet present", () => {
    for (const backend of collaborationAgentSchema.options) {
      expect(
        collaborationBackendRefusal(getBackendCatalogEntry(backend)),
      ).toBeNull();
    }
  });

  it("refuses a participant whose lane facet is missing, naming the facet and the surface", () => {
    const reason = collaborationBackendRefusal(
      entryWithFacets(getBackendCatalogEntry("cursor"), {
        conversation: true,
        tasks: false,
      }),
    );

    expect(reason).not.toBeNull();
    expect(reason).toContain("Cursor");
    expect(reason).toContain("task");
    expect(reason).toContain("Collaboration Mode");
  });

  // The facet a participant needs follows how its lane is dispatched: a Claude
  // lane is a conversation turn, so Claude keeps its lane without a task facet
  // and loses it without a conversation facet.
  it("gates each participant on the facet its lane dispatch actually uses", () => {
    const claude = getBackendCatalogEntry("claude");
    expect(
      collaborationBackendRefusal(
        entryWithFacets(claude, { conversation: true, tasks: false }),
      ),
    ).toBeNull();
    const reason = collaborationBackendRefusal(
      entryWithFacets(claude, { conversation: false, tasks: true }),
    );
    expect(reason).toContain("conversation");
    expect(reason).toContain("Collaboration Mode");
  });

  // A backend outside the participation list is refused by policy even when
  // it registers every facet: registering a task runner is not what admits a
  // participant.
  it("refuses a task-capable backend outside the participation policy for the policy reason", () => {
    const outsider = {
      ...getBackendCatalogEntry("codex"),
      id: "outsider" as AgentBackendId,
      label: "Outsider",
      facets: { conversation: true, tasks: true },
    };
    const admission = collaborationBackendAdmission(outsider);
    expect(admission).toMatchObject({ ok: false, cause: "pair_policy" });
    const reason = collaborationBackendRefusal(outsider);
    expect(reason).toContain("Outsider");
    expect(reason).toContain("Claude, Codex, and Cursor");
    // The id-only form cannot know an unregistered label, but names the same
    // policy for the same reason.
    expect(collaborationAgentRefusal(outsider.id)).toContain(
      "Claude, Codex, and Cursor",
    );
  });

  it("classifies a missing lane facet separately from the participation policy", () => {
    expect(
      collaborationBackendAdmission(
        entryWithFacets(getBackendCatalogEntry("cursor"), {
          conversation: true,
          tasks: false,
        }),
      ),
    ).toMatchObject({ ok: false, cause: "facet" });
    expect(
      collaborationBackendAdmission(getBackendCatalogEntry("cursor")),
    ).toEqual({ ok: true });
  });
});
