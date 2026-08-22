import { describe, expect, it } from "vitest";
import { makeProfileSnapshot } from "@/lib/workflow-graph/test-fixtures";
import type { GraphWorkflowResolvedContext } from "@/lib/workflow-graph/definition-schemas";
import {
  diffLiveContextOp,
  liveConfigProvenance,
  rebaseLiveDraft,
  serializeOutputSchemaText,
  toLiveDraft,
} from "./live-context-draft";

/**
 * The live draft is the only place the panel's authored vocabulary meets the
 * execution's snapshotted one, so these tests pin the two rules that boundary
 * exists for: a value the run holds is shown verbatim, and an edit to one field
 * never rewrites the provenance of its siblings.
 */

function storedContext(
  overrides: Partial<GraphWorkflowResolvedContext> = {},
): GraphWorkflowResolvedContext {
  return {
    id: "context-impl",
    title: "Implement",
    description: "Do the work",
    acceptanceCriteria: "It works",
    placement: { lane: "delivery", mode: "full" },
    implementer: {
      id: "implementer",
      profile: { tier: "builtin", id: "general-implementer" },
      profileSnapshot: makeProfileSnapshot(),
      agent: { backend: "claude", model: "opus", reasoningEffort: "high" },
    },
    contextValidator: {
      enabled: true,
      assignments: [
        {
          id: "general",
          profile: { tier: "builtin", id: "general-reviewer" },
          profileSnapshot: makeProfileSnapshot(),
          strategy: "conversation",
          authority: "blocking",
          agent: {
            backend: "claude",
            model: "sonnet",
            reasoningEffort: "medium",
          },
          continuity: { enabled: true },
        },
      ],
    },
    scriptValidator: { commands: ["typecheck"] },
    scriptValidatorSource: "workflow",
    humanApprovalGate: { enabled: true },
    askUserQuestions: { enabled: false },
    mutability: { allowAgentTaskAdd: false, allowAgentContextAdd: true },
    circuitBreaker: { consecutiveFailureThreshold: 3 },
    iterationPolicy: { maxIterations: 20, continuity: { enabled: true } },
    planRepair: { enabled: true, maxAttemptsPerContext: 2 },
    collaboration: {
      enabled: { value: true, source: "workflow" },
      secondAgent: {
        value: { backend: "codex", model: "gpt-5.4", reasoningEffort: "high" },
        source: "global",
      },
      negotiationRounds: { value: 5, source: "per-node" },
      autonomousResolutionThreshold: { value: "major", source: "global" },
    },
    agentValidation: {
      implementer: {
        value: { mode: "all", except: [] },
        source: "global",
      },
      contextValidator: {
        value: { mode: "only", commands: ["test"] },
        source: "workflow",
      },
    },
    ...overrides,
  };
}

describe("toLiveDraft", () => {
  it("strips the seeded profile snapshot from every assignment", () => {
    const draft = toLiveDraft(storedContext());

    expect(draft.context.implementer).not.toHaveProperty("profileSnapshot");
    expect(draft.context.contextValidator?.assignments[0]).not.toHaveProperty(
      "profileSnapshot",
    );
    expect(draft.context.implementer?.profile).toEqual({
      tier: "builtin",
      id: "general-implementer",
    });
  });

  it("carries every cascade block concretely, flattening the provenanced blocks", () => {
    const draft = toLiveDraft(storedContext());

    expect(draft.context.collaboration).toEqual({
      enabled: true,
      secondAgent: {
        backend: "codex",
        model: "gpt-5.4",
        reasoningEffort: "high",
      },
      negotiationRounds: 5,
      autonomousResolutionThreshold: "major",
    });
    expect(draft.context.agentValidation).toEqual({
      implementer: { mode: "all", except: [] },
      contextValidator: { mode: "only", commands: ["test"] },
    });
    expect(draft.context.circuitBreaker).toEqual({
      consecutiveFailureThreshold: 3,
    });
    expect(draft.context.mutability).toEqual({
      allowAgentTaskAdd: false,
      allowAgentContextAdd: true,
    });
  });

  it("normalizes prose acceptance criteria to ordered records", () => {
    const draft = toLiveDraft(storedContext());

    expect(draft.context.acceptanceCriteria).toEqual([
      { id: "ac-1", statement: "It works" },
    ]);
  });

  it("seeds the schema text from the stored document, empty when there is none", () => {
    expect(toLiveDraft(storedContext()).outputSchemaText).toBe("");
    expect(
      toLiveDraft(
        storedContext({ outputSchema: { type: "object", properties: {} } }),
      ).outputSchemaText,
    ).toBe(serializeOutputSchemaText({ type: "object", properties: {} }));
  });
});

describe("liveConfigProvenance", () => {
  it("proves a tier only where the seed recorded one", () => {
    const provenance = liveConfigProvenance(storedContext());

    expect(provenance["collaboration.enabled"]).toBe("workflow");
    expect(provenance["collaboration.secondAgent"]).toBe("global");
    expect(provenance["collaboration.negotiationRounds"]).toBe("context");
    expect(provenance["agentValidation.implementer"]).toBe("global");
    expect(provenance["agentValidation.contextValidator"]).toBe("workflow");
    expect(provenance.scriptValidator).toBe("workflow");
  });

  it("leaves a block with no recorded source unproven", () => {
    const provenance = liveConfigProvenance(storedContext());

    expect(provenance.circuitBreaker).toBeUndefined();
    expect(provenance.implementer).toBeUndefined();
    expect(provenance.mutability).toBeUndefined();
  });

  it("reads a run seeded before the snapshots existed as global", () => {
    const legacy = storedContext();
    delete legacy.collaboration;
    delete legacy.agentValidation;
    delete legacy.scriptValidatorSource;

    const provenance = liveConfigProvenance(legacy);

    expect(provenance["collaboration.enabled"]).toBe("global");
    expect(provenance["agentValidation.implementer"]).toBe("global");
    expect(provenance.scriptValidator).toBe("global");
  });
});

describe("diffLiveContextOp", () => {
  function draftPair() {
    const stored = storedContext();
    return { stored, base: toLiveDraft(stored), draft: toLiveDraft(stored) };
  }

  it("emits nothing when nothing changed", () => {
    const { stored, base, draft } = draftPair();

    expect(
      diffLiveContextOp({ contextId: stored.id, draft, base, stored }),
    ).toBeNull();
  });

  it("attributes only the edited collaboration field to the context", () => {
    const { stored, base, draft } = draftPair();
    const edited = {
      ...draft,
      context: {
        ...draft.context,
        collaboration: { ...draft.context.collaboration, negotiationRounds: 9 },
      },
    };

    const op = diffLiveContextOp({
      contextId: stored.id,
      draft: edited,
      base,
      stored,
    });

    expect(op?.type).toBe("update-context");
    expect(op).toMatchObject({
      collaboration: {
        negotiationRounds: { value: 9, source: "per-node" },
        // Untouched siblings echo the tier the seed recorded — an edit to one
        // field never promotes the block.
        enabled: { value: true, source: "workflow" },
        secondAgent: { source: "global" },
        autonomousResolutionThreshold: { source: "global" },
      },
    });
  });

  it("attributes only the edited validation role to the context", () => {
    const { stored, base, draft } = draftPair();
    const edited = {
      ...draft,
      context: {
        ...draft.context,
        agentValidation: {
          ...draft.context.agentValidation,
          implementer: { mode: "only" as const, commands: [] },
        },
      },
    };

    const op = diffLiveContextOp({
      contextId: stored.id,
      draft: edited,
      base,
      stored,
    });

    expect(op).toMatchObject({
      agentValidation: {
        implementer: {
          value: { mode: "only", commands: [] },
          source: "per-node",
        },
        contextValidator: {
          value: { mode: "only", commands: ["test"] },
          source: "workflow",
        },
      },
    });
  });

  it("round-trips a field the panel never authors", () => {
    const { stored, base, draft } = draftPair();
    const edited = {
      ...draft,
      context: {
        ...draft.context,
        mutability: { allowAgentTaskAdd: true, allowAgentContextAdd: true },
      },
    };

    const op = diffLiveContextOp({
      contextId: stored.id,
      draft: edited,
      base,
      stored,
    });

    expect(op).toMatchObject({
      mutability: { allowAgentTaskAdd: true, allowAgentContextAdd: true },
    });
  });

  it("restates the whole acceptance-criteria list", () => {
    const { stored, base, draft } = draftPair();
    const edited = {
      ...draft,
      context: {
        ...draft.context,
        acceptanceCriteria: [
          { id: "ac-1", statement: "It works" },
          { id: "ac-2", statement: "And it is audited" },
        ],
      },
    };

    const op = diffLiveContextOp({
      contextId: stored.id,
      draft: edited,
      base,
      stored,
    });

    expect(op).toMatchObject({
      acceptanceCriteria: [
        { id: "ac-1", statement: "It works" },
        { id: "ac-2", statement: "And it is audited" },
      ],
    });
  });

  it("replaces placement wholesale", () => {
    const { stored, base, draft } = draftPair();
    const edited = {
      ...draft,
      context: {
        ...draft.context,
        placement: {
          lane: "review",
          mode: "owned" as const,
          ownedPaths: ["src/checkout/"],
        },
      },
    };

    const op = diffLiveContextOp({
      contextId: stored.id,
      draft: edited,
      base,
      stored,
    });

    expect(op).toMatchObject({
      placement: {
        lane: "review",
        mode: "owned",
        ownedPaths: ["src/checkout/"],
      },
    });
  });

  it("parses acceptable schema text, clears on empty, and emits nothing while unparseable", () => {
    const { stored, base, draft } = draftPair();
    const withSchema = {
      ...draft,
      outputSchemaText:
        '{"type":"object","properties":{"ok":{"type":"boolean"}}}',
    };
    expect(
      diffLiveContextOp({
        contextId: stored.id,
        draft: withSchema,
        base,
        stored,
      }),
    ).toMatchObject({
      outputSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
      },
    });

    const stale = toLiveDraft(
      storedContext({ outputSchema: { type: "object", properties: {} } }),
    );
    expect(
      diffLiveContextOp({
        contextId: stored.id,
        draft: { ...stale, outputSchemaText: "" },
        base: stale,
        stored,
      }),
    ).toMatchObject({ outputSchema: null });

    expect(
      diffLiveContextOp({
        contextId: stored.id,
        draft: { ...draft, outputSchemaText: "{ not json" },
        base,
        stored,
      }),
    ).toBeNull();
  });
});

describe("rebaseLiveDraft", () => {
  it("keeps the edited field and adopts a concurrent change to an untouched one", () => {
    const stored = storedContext();
    const seedBase = toLiveDraft(stored);
    const draft = {
      ...seedBase,
      context: { ...seedBase.context, title: "Implement checkout" },
    };
    const freshBase = toLiveDraft(
      storedContext({ description: "Rewritten upstream" }),
    );

    const rebased = rebaseLiveDraft(draft, seedBase, freshBase);

    expect(rebased.context.title).toBe("Implement checkout");
    expect(rebased.context.description).toBe("Rewritten upstream");
  });

  it("rebases collaboration per FIELD, not as one block", () => {
    // Cascade granularity: collaboration is four independent fields. Merging
    // the block wholesale keeps our stale siblings, and the diff then restates
    // them as per-node — silently overwriting AND promoting a field the author
    // never touched.
    const stored = storedContext();
    const seedBase = toLiveDraft(stored);
    const draft = {
      ...seedBase,
      context: {
        ...seedBase.context,
        collaboration: { ...seedBase.context.collaboration, enabled: false },
      },
    };
    const freshBase = toLiveDraft(
      storedContext({
        collaboration: {
          enabled: { value: true, source: "workflow" },
          secondAgent: {
            value: {
              backend: "codex",
              model: "gpt-5.4",
              reasoningEffort: "high",
            },
            source: "global",
          },
          // A concurrent editor moved a sibling field.
          negotiationRounds: { value: 9, source: "per-node" },
          autonomousResolutionThreshold: { value: "major", source: "global" },
        },
      }),
    );

    const rebased = rebaseLiveDraft(draft, seedBase, freshBase);

    expect(rebased.context.collaboration?.enabled).toBe(false);
    expect(rebased.context.collaboration?.negotiationRounds).toBe(9);
  });

  it("rebases agent validation per ROLE, not as one block", () => {
    const stored = storedContext();
    const seedBase = toLiveDraft(stored);
    const draft = {
      ...seedBase,
      context: {
        ...seedBase.context,
        agentValidation: {
          ...seedBase.context.agentValidation,
          implementer: { mode: "only" as const, commands: ["lint"] },
        },
      },
    };
    const freshBase = toLiveDraft(
      storedContext({
        agentValidation: {
          implementer: { value: { mode: "all", except: [] }, source: "global" },
          // The other role moved concurrently.
          contextValidator: {
            value: { mode: "only", commands: ["test", "build"] },
            source: "workflow",
          },
        },
      }),
    );

    const rebased = rebaseLiveDraft(draft, seedBase, freshBase);

    expect(rebased.context.agentValidation?.implementer).toEqual({
      mode: "only",
      commands: ["lint"],
    });
    expect(rebased.context.agentValidation?.contextValidator).toEqual({
      mode: "only",
      commands: ["test", "build"],
    });
  });
});
