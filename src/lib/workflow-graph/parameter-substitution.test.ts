import { describe, expect, it } from "vitest";

import type { WorkflowCharter } from "@/lib/workflows/charter-schemas";
import type { WorkflowSemanticDefinition } from "@/lib/workflow-graph/definition-schemas";

import { forEachScannedField, mapScannedFields } from "./parameter-validation";
import { substituteContent } from "./parameter-substitution";

function charter(overrides: Partial<WorkflowCharter> = {}): WorkflowCharter {
  return {
    mission: "Ship {{inputs.feature}}",
    conventions: ["Follow {{inputs.feature}} conventions"],
    nonGoals: ["No {{inputs.feature}} rewrite"],
    vocabulary: ["{{inputs.feature}}: meaning"],
    testStrategy: "Test {{inputs.feature}} thoroughly",
    knownAmbiguities: ["scope of {{inputs.feature}}"],
    sourcesOfTruth: [
      {
        rank: 1,
        id: "primary",
        label: "{{inputs.feature}} spec",
        type: "spec",
        locator: "specs/{{inputs.feature}}.md",
        description: "The {{inputs.feature}} spec",
        appliesTo: "all of {{inputs.feature}}",
        accessPolicy: "worktree-relative",
      },
    ],
    ...overrides,
  };
}

function definition(
  overrides: Partial<WorkflowSemanticDefinition> = {},
): WorkflowSemanticDefinition {
  return {
    schemaVersion: 1,
    workflowConfig: {},
    charter: charter(),
    prerequisites: [],
    parameters: [
      {
        type: "string",
        name: "feature",
        label: "Feature",
        required: true,
      },
    ],
    executionContexts: [
      {
        id: "ctx-1",
        title: "Build {{inputs.feature}}",
        description: "Context for {{inputs.feature}}",
        acceptanceCriteria: "{{inputs.feature}} works",
        placement: { lane: "ctx-1", mode: "full" },
      },
    ],
    tasks: [
      {
        id: "task-1",
        contextId: "ctx-1",
        order: 1,
        title: "Task one",
        instructions: "Implement {{inputs.feature}}",
        source: "user",
      },
    ],
    edges: [],
    ...overrides,
  };
}

describe("substituteContent", () => {
  describe("substitutes across the full scanned-field surface (R4.1)", () => {
    it("substitutes into every content field", () => {
      const result = substituteContent(definition(), { feature: "auth" });

      const context = result.executionContexts[0];
      expect(context?.title).toBe("Build auth");
      expect(context?.description).toBe("Context for auth");
      expect(context?.acceptanceCriteria).toBe("auth works");
      expect(result.tasks[0]?.instructions).toBe("Implement auth");
    });

    it("substitutes into every agent-rendered charter text field", () => {
      const result = substituteContent(definition(), { feature: "auth" });
      const c = result.charter;

      expect(c.mission).toBe("Ship auth");
      expect(c.conventions).toEqual(["Follow auth conventions"]);
      expect(c.nonGoals).toEqual(["No auth rewrite"]);
      expect(c.vocabulary).toEqual(["auth: meaning"]);
      expect(c.testStrategy).toBe("Test auth thoroughly");
      expect(c.knownAmbiguities).toEqual(["scope of auth"]);

      const source = c.sourcesOfTruth[0];
      expect(source?.label).toBe("auth spec");
      expect(source?.locator).toBe("specs/auth.md");
      expect(source?.description).toBe("The auth spec");
      expect(source?.appliesTo).toBe("all of auth");
    });

    it("replaces every occurrence of a token within a single field", () => {
      const def = definition({
        tasks: [
          {
            id: "task-1",
            contextId: "ctx-1",
            order: 1,
            title: "Task one",
            instructions: "{{inputs.feature}} and {{inputs.feature}} again",
            source: "user",
          },
        ],
      });

      const result = substituteContent(def, { feature: "auth" });
      expect(result.tasks[0]?.instructions).toBe("auth and auth again");
    });
  });

  describe("leaves structural / config fields untouched (R4.3, R4.4)", () => {
    it("does not alter ids, task.order, edges, or charter structural fields", () => {
      const def = definition({
        edges: [
          {
            id: "edge-1",
            sourceContextId: "ctx-1",
            targetContextId: "ctx-1",
          },
        ],
      });

      const result = substituteContent(def, { feature: "auth" });

      expect(result.executionContexts[0]?.id).toBe("ctx-1");
      expect(result.tasks[0]?.id).toBe("task-1");
      expect(result.tasks[0]?.contextId).toBe("ctx-1");
      expect(result.tasks[0]?.order).toBe(1);
      expect(result.tasks[0]?.title).toBe("Task one");
      expect(result.edges).toEqual(def.edges);

      const source = result.charter.sourcesOfTruth[0];
      expect(source?.id).toBe("primary");
      expect(source?.rank).toBe(1);
      expect(source?.type).toBe("spec");
      expect(source?.accessPolicy).toBe("worktree-relative");
    });

    it("copies config fields through untouched while substituting scanned fields (R4.3)", () => {
      const def = definition({
        executionContexts: [
          {
            id: "ctx-1",
            title: "Build {{inputs.feature}}",
            acceptanceCriteria: "Works",
            placement: { lane: "ctx-1", mode: "full" },
            scriptValidator: { commands: ["pre-merge"] },
            humanApprovalGate: { enabled: true },
          },
        ],
      });

      const result = substituteContent(def, { feature: "auth" });
      // Config blocks are not part of the scanned surface — copied verbatim.
      expect(result.executionContexts[0]?.scriptValidator).toEqual({
        commands: ["pre-merge"],
      });
      expect(result.executionContexts[0]?.humanApprovalGate).toEqual({
        enabled: true,
      });
      // The scanned title is still substituted.
      expect(result.executionContexts[0]?.title).toBe("Build auth");
    });

    it("does not mutate the input definition", () => {
      const def = definition();
      const before = structuredClone(def);

      substituteContent(def, { feature: "auth" });

      expect(def).toEqual(before);
    });
  });

  describe("determinism (R4.5)", () => {
    it("produces deep-equal output for identical inputs", () => {
      const def = definition();
      const a = substituteContent(def, { feature: "auth" });
      const b = substituteContent(def, { feature: "auth" });
      expect(a).toEqual(b);
    });
  });

  describe("single simultaneous pass, verbatim (R4.7, R5.5)", () => {
    it("inserts a bound value containing a literal {{...}} verbatim without re-substituting", () => {
      const def = definition({
        parameters: [{ type: "text", name: "ci", label: "CI", required: true }],
        tasks: [
          {
            id: "task-1",
            contextId: "ctx-1",
            order: 1,
            title: "Task one",
            instructions: "Use {{inputs.ci}} matrix",
            source: "user",
          },
        ],
        executionContexts: [
          {
            id: "ctx-1",
            title: "Ctx",
            acceptanceCriteria: "ok",
            placement: { lane: "ctx-1", mode: "full" },
          },
        ],
        charter: {
          mission: "Build it",
          sourcesOfTruth: [
            {
              rank: 1,
              id: "primary",
              label: "Primary",
              type: "spec",
              locator: "spec.md",
              description: "spec",
              accessPolicy: "worktree-relative",
            },
          ],
        },
      });

      const result = substituteContent(def, { ci: "${{ matrix.os }}" });
      // The literal `{{ matrix.os }}` came from the bound VALUE — it must survive
      // verbatim, not be re-scanned or rejected.
      expect(result.tasks[0]?.instructions).toBe("Use ${{ matrix.os }} matrix");
    });

    it("inserts a bound value that itself contains a literal {{inputs.other}} verbatim, never re-substituting it", () => {
      const def = definition({
        parameters: [
          { type: "text", name: "brief", label: "Brief", required: true },
          { type: "string", name: "other", label: "Other", required: true },
        ],
        tasks: [
          {
            id: "task-1",
            contextId: "ctx-1",
            order: 1,
            title: "Task one",
            instructions: "Brief: {{inputs.brief}} | other: {{inputs.other}}",
            source: "user",
          },
        ],
        executionContexts: [
          {
            id: "ctx-1",
            title: "Ctx",
            acceptanceCriteria: "ok",
            placement: { lane: "ctx-1", mode: "full" },
          },
        ],
        charter: {
          mission: "Build it",
          sourcesOfTruth: [
            {
              rank: 1,
              id: "primary",
              label: "Primary",
              type: "spec",
              locator: "spec.md",
              description: "spec",
              accessPolicy: "worktree-relative",
            },
          ],
        },
      });

      const result = substituteContent(def, {
        brief: "describes {{inputs.other}} syntax",
        other: "REAL",
      });

      // The `{{inputs.other}}` inside the brief value is NOT re-substituted; only
      // the template's own `{{inputs.other}}` token is replaced with REAL.
      expect(result.tasks[0]?.instructions).toBe(
        "Brief: describes {{inputs.other}} syntax | other: REAL",
      );
    });

    it("does not throw when a bound value contains a literal {{inputs.<name>}} for an unbound name", () => {
      const def = definition({
        parameters: [
          { type: "text", name: "brief", label: "Brief", required: true },
        ],
        tasks: [
          {
            id: "task-1",
            contextId: "ctx-1",
            order: 1,
            title: "Task one",
            instructions: "Brief: {{inputs.brief}}",
            source: "user",
          },
        ],
        executionContexts: [
          {
            id: "ctx-1",
            title: "Ctx",
            acceptanceCriteria: "ok",
            placement: { lane: "ctx-1", mode: "full" },
          },
        ],
        charter: {
          mission: "Build it",
          sourcesOfTruth: [
            {
              rank: 1,
              id: "primary",
              label: "Primary",
              type: "spec",
              locator: "spec.md",
              description: "spec",
              accessPolicy: "worktree-relative",
            },
          ],
        },
      });

      // `unbound` is not in boundInputs, but it only appears INSIDE the value —
      // never as a template token — so it must not trigger the residual throw.
      expect(() =>
        substituteContent(def, {
          brief: "mentions {{inputs.unbound}} verbatim",
        }),
      ).not.toThrow();

      const result = substituteContent(def, {
        brief: "mentions {{inputs.unbound}} verbatim",
      });
      expect(result.tasks[0]?.instructions).toBe(
        "Brief: mentions {{inputs.unbound}} verbatim",
      );
    });
  });

  describe("no residual template placeholder (R4.7)", () => {
    it("leaves no template placeholder after a fully-bound substitution", () => {
      const result = substituteContent(definition(), { feature: "auth" });

      forEachScannedField(result, (_locator, value) => {
        expect(value).not.toContain("{{inputs.feature}}");
      });
    });
  });

  describe("fail-closed on unbound template reference (R4.7)", () => {
    it("throws when a template references a name absent from boundInputs", () => {
      const def = definition({
        tasks: [
          {
            id: "task-1",
            contextId: "ctx-1",
            order: 1,
            title: "Task one",
            instructions: "Use {{inputs.missing}} here",
            source: "user",
          },
        ],
      });

      expect(() => substituteContent(def, { feature: "auth" })).toThrow(
        /missing/,
      );
    });

    it("throws even when other references are fully bound", () => {
      const def = definition({
        parameters: [
          { type: "string", name: "feature", label: "Feature", required: true },
          { type: "string", name: "absent", label: "Absent", required: true },
        ],
        tasks: [
          {
            id: "task-1",
            contextId: "ctx-1",
            order: 1,
            title: "Task one",
            instructions: "{{inputs.feature}} and {{inputs.absent}}",
            source: "user",
          },
        ],
      });

      expect(() => substituteContent(def, { feature: "auth" })).toThrow();
    });
  });

  describe("zero-token definition", () => {
    it("returns an equivalent definition when there are no placeholders", () => {
      const def = definition({
        charter: {
          mission: "Plain mission",
          sourcesOfTruth: [
            {
              rank: 1,
              id: "primary",
              label: "Primary",
              type: "spec",
              locator: "spec.md",
              description: "spec",
              accessPolicy: "worktree-relative",
            },
          ],
        },
        executionContexts: [
          {
            id: "ctx-1",
            title: "Plain",
            acceptanceCriteria: "ok",
            placement: { lane: "ctx-1", mode: "full" },
          },
        ],
        tasks: [
          {
            id: "task-1",
            contextId: "ctx-1",
            order: 1,
            title: "Task one",
            instructions: "Plain instructions",
            source: "user",
          },
        ],
      });

      const result = substituteContent(def, {});
      expect(result).toEqual(def);
    });
  });
});

describe("mapScannedFields is pinned to forEachScannedField", () => {
  // The write surface MUST be exactly the read surface: running both over a
  // sentineled definition, the set of touched locators must be identical, so the
  // two surfaces literally cannot drift.
  function sentineledDefinition(): WorkflowSemanticDefinition {
    return definition({
      charter: {
        mission: "SENTINEL_mission",
        conventions: ["SENTINEL_conventions"],
        nonGoals: ["SENTINEL_nonGoals"],
        vocabulary: ["SENTINEL_vocabulary"],
        testStrategy: "SENTINEL_testStrategy",
        knownAmbiguities: ["SENTINEL_knownAmbiguities"],
        sourcesOfTruth: [
          {
            rank: 1,
            id: "primary",
            label: "SENTINEL_label",
            type: "spec",
            locator: "SENTINEL_locator",
            description: "SENTINEL_description",
            appliesTo: "SENTINEL_appliesTo",
            accessPolicy: "worktree-relative",
          },
        ],
      },
      executionContexts: [
        {
          id: "ctx-1",
          title: "SENTINEL_title",
          description: "SENTINEL_ctxDescription",
          acceptanceCriteria: "SENTINEL_acceptanceCriteria",
          placement: { lane: "ctx-1", mode: "full" },
        },
      ],
      tasks: [
        {
          id: "task-1",
          contextId: "ctx-1",
          order: 1,
          title: "Task one",
          instructions: "SENTINEL_instructions",
          source: "user",
        },
      ],
    });
  }

  it("transforms exactly the locators forEachScannedField reads", () => {
    const def = sentineledDefinition();

    const readLocators = new Set<string>();
    forEachScannedField(def, (locator) => {
      readLocators.add(locator);
    });

    const writeLocators = new Set<string>();
    mapScannedFields(def, (value, locator) => {
      writeLocators.add(locator);
      return value;
    });

    expect(writeLocators).toEqual(readLocators);
    expect(writeLocators.size).toBeGreaterThan(0);
  });

  it("returns a new definition with only the scanned fields transformed and the input untouched", () => {
    const def = sentineledDefinition();
    const before = structuredClone(def);

    const result = mapScannedFields(def, (value) => `${value}!`);

    // Input not mutated.
    expect(def).toEqual(before);
    // Result is a distinct object.
    expect(result).not.toBe(def);

    // Scanned fields transformed.
    expect(result.charter.mission).toBe("SENTINEL_mission!");
    expect(result.tasks[0]?.instructions).toBe("SENTINEL_instructions!");
    // Structural fields copied through untouched.
    expect(result.charter.sourcesOfTruth[0]?.id).toBe("primary");
    expect(result.edges).toEqual(def.edges);
    expect(result.parameters).toEqual(def.parameters);
  });
});
