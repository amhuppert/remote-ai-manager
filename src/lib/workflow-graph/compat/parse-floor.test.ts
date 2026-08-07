import { describe, expect, it } from "vitest";
import { graphWorkflowExecutionSchema } from "@/lib/workflow-graph/schemas";
import {
  resolvedWorkflowSemanticDefinitionSchema,
  workflowSemanticDefinitionSchema,
} from "@/lib/workflow-graph/definition-schemas";
import {
  D4_ADDITIVE_FIELDS,
  projectDefinitionFloor,
  projectExecutionTierFloor,
} from "./floor";
import {
  COMPATIBILITY_SCENARIOS,
  readDefinitionFixture,
  readExecutionFixture,
} from "./scenarios";

const DORMANT_DEFINITION_FLOOR = {
  edgeActivation: "all-unconditional",
  loops: "none-declared",
  expansionAuthority: "disabled-on-every-context",
} as const;

/**
 * R14.1's parse half: a definition or persisted execution written before D4
 * carries none of the fields in {@link D4_ADDITIVE_FIELDS}, and must therefore
 * parse at the dormant floor — every edge unconditional, no loop groups, and
 * expansion authority disabled on every context — on BOTH tiers (the authored
 * definition and the persisted execution's resolved working definition).
 */
describe("pre-D4 parse floor", () => {
  describe("authored definition tier", () => {
    for (const scenarioName of COMPATIBILITY_SCENARIOS) {
      it(`parses "${scenarioName}" at the dormant floor`, () => {
        const parsed = workflowSemanticDefinitionSchema.parse(
          readDefinitionFixture(scenarioName),
        );

        expect(projectDefinitionFloor(parsed)).toEqual(
          DORMANT_DEFINITION_FLOOR,
        );
      });
    }
  });

  describe("persisted execution tier", () => {
    it("parses a pre-D4 execution blob at the dormant floor", () => {
      const parsed = graphWorkflowExecutionSchema.parse(
        readExecutionFixture("linear-chain"),
      );

      expect(projectExecutionTierFloor(parsed)).toEqual({
        ...DORMANT_DEFINITION_FLOOR,
        routing: "no-recorded-decisions",
        skips: "none",
      });
    });

    it("keeps the resolved working definition at the floor after a schema round trip", () => {
      const parsed = graphWorkflowExecutionSchema.parse(
        readExecutionFixture("linear-chain"),
      );
      const reparsed = resolvedWorkflowSemanticDefinitionSchema.parse(
        parsed.workingDefinition,
      );

      expect(reparsed).toEqual(parsed.workingDefinition);
      expect(projectDefinitionFloor(reparsed)).toEqual(
        DORMANT_DEFINITION_FLOOR,
      );
    });
  });

  /**
   * R14 states the floor SEMANTICALLY ("shall parse as unconditional edges, no
   * loops, and expansion disabled"), not as omission preservation — a post-D4
   * schema is free to materialize every additive field at its dormant default.
   * These assertions therefore feed the probes the shape a D4-enabled parse of
   * the SAME pre-D4 input produces and require the identical floor verdict.
   */
  describe("dormant defaults materialized", () => {
    it("holds the definition floor when every D4 field parses to its disabled default", () => {
      const definition = workflowSemanticDefinitionSchema.parse(
        readDefinitionFixture("linear-chain"),
      );

      expect(
        projectDefinitionFloor({
          ...definition,
          loopGroups: [],
          edges: definition.edges.map((edge) => ({ ...edge, when: null })),
          executionContexts: definition.executionContexts.map((context) => ({
            ...context,
            routing: null,
            mutability: {
              ...context.mutability,
              allowAgentGraphExpansion: false,
            },
          })),
        }),
      ).toEqual(DORMANT_DEFINITION_FLOOR);
    });

    it("holds the execution floor when every D4 runtime field parses to its dormant default", () => {
      const execution = graphWorkflowExecutionSchema.parse(
        readExecutionFixture("linear-chain"),
      );
      const routeControlRevisions = graphWorkflowExecutionSchema.parse({
        ...execution,
        routeControlRevisions: {},
      }).routeControlRevisions;

      expect(
        projectExecutionTierFloor({
          workingDefinition: {
            ...execution.workingDefinition,
            loopGroups: [],
            edges: execution.workingDefinition.edges.map((edge) => ({
              ...edge,
              when: null,
            })),
            executionContexts:
              execution.workingDefinition.executionContexts.map((context) => ({
                ...context,
                routing: null,
                mutability: {
                  ...context.mutability,
                  allowAgentGraphExpansion: false,
                },
              })),
          },
          contextStates: Object.fromEntries(
            Object.entries(execution.contextStates).map(
              ([contextId, contextState]) => [
                contextId,
                { ...contextState, skipReason: null, landingIntent: null },
              ],
            ),
          ),
          routeSettlements: {},
          routeControlRevisions,
          loopStates: {},
          // The REAL dormant shape of the expansion ledgers: a record whose two
          // ledgers are always present and empty. A probe that read the two
          // always-present keys as evidence would report every post-D4
          // execution as having recorded decisions.
          expansionReceipts: { accepted: [], refusals: [] },
        }),
      ).toEqual({
        ...DORMANT_DEFINITION_FLOOR,
        routing: "no-recorded-decisions",
        skips: "none",
      });
    });

    it("reads an explicitly disabled expansion flag as disabled", () => {
      expect(
        projectDefinitionFloor({
          edges: [],
          executionContexts: [
            {
              id: "a",
              mutability: {
                allowAgentTaskAdd: false,
                allowAgentGraphExpansion: false,
              },
            },
          ],
        }).expansionAuthority,
      ).toBe("disabled-on-every-context");
    });

    it("reads a nested expansion-authority block disabled at its leaf as disabled", () => {
      expect(
        projectDefinitionFloor({
          edges: [],
          executionContexts: [
            {
              id: "a",
              mutability: {
                allowAgentTaskAdd: false,
                agentGraphExpansion: { enabled: false, maxNodes: 0 },
              },
            },
          ],
        }).expansionAuthority,
      ).toBe("disabled-on-every-context");
    });

    it("keeps the inventory the probes read in sync with the floor sites", () => {
      // The probes only see a field the inventory lists, so an unlisted D4
      // field is invisible to them. Pin the inventory shape so adding a
      // persisted field without registering it is a visible diff here.
      expect(D4_ADDITIVE_FIELDS).toEqual({
        definition: ["loopGroups"],
        edge: ["when"],
        context: ["routing"],
        execution: [
          "routeSettlements",
          "routeControlRevisions",
          "loopStates",
          "expansionReceipts",
          "loopControlAmendments",
        ],
        contextState: ["skipReason", "landingIntent"],
      });
    });
  });

  // Positive controls. The floor verdict on a pre-D4 fixture only means
  // something if the probe can see a D4 field when one is present, so each
  // verdict is exercised against the shape a later D4 slice will produce.
  describe("probe sensitivity", () => {
    it("reports a guard on an edge carrying an activation document", () => {
      expect(
        projectDefinitionFloor({
          edges: [
            {
              id: "edge-1",
              sourceContextId: "a",
              targetContextId: "b",
              when: {
                type: "object",
                properties: { verdict: { const: "go" } },
              },
            },
          ],
          executionContexts: [],
        }).edgeActivation,
      ).toBe("guard-declared");
    });

    it("reports declared loops on a definition carrying loop groups", () => {
      expect(
        projectDefinitionFloor({
          edges: [],
          executionContexts: [],
          loopGroups: [{ id: "loop-1", maxPasses: 3 }],
        }).loops,
      ).toBe("declared");
    });

    it("reports enabled expansion authority on a context whose mutability grew a flag", () => {
      expect(
        projectDefinitionFloor({
          edges: [],
          executionContexts: [
            {
              id: "a",
              mutability: {
                allowAgentTaskAdd: false,
                allowAgentGraphExpansion: true,
              },
            },
          ],
        }).expansionAuthority,
      ).toBe("enabled-somewhere");
    });

    it("reports enabled expansion authority on a nested block turned on at its leaf", () => {
      expect(
        projectDefinitionFloor({
          edges: [],
          executionContexts: [
            {
              id: "a",
              mutability: {
                allowAgentTaskAdd: false,
                agentGraphExpansion: { enabled: true, maxNodes: 8 },
              },
            },
          ],
        }).expansionAuthority,
      ).toBe("enabled-somewhere");
    });

    it("reports recorded routing and skips on an execution carrying D4 runtime state", () => {
      expect(
        projectExecutionTierFloor({
          workingDefinition: { edges: [], executionContexts: [] },
          contextStates: { a: { contextId: "a", skipReason: "guard_false" } },
          routeSettlements: {
            a: {
              sourceContextId: "a",
              routeControlRevision: 1,
              activatedEdgeIds: ["edge-1"],
              settledAt: "2026-01-02T06:00:00.000Z",
            },
          },
        }),
      ).toMatchObject({
        routing: "decisions-recorded",
        skips: "present",
      });
    });

    it("reports recorded routing on an execution whose expansion ledger holds a receipt", () => {
      expect(
        projectExecutionTierFloor({
          workingDefinition: { edges: [], executionContexts: [] },
          contextStates: {},
          expansionReceipts: {
            accepted: [],
            refusals: [
              {
                requestId: "req-1",
                invokerContextId: "a",
                refusalCode: "expansion-cap-contexts-per-request",
              },
            ],
          },
        }).routing,
      ).toBe("decisions-recorded");
    });
  });
});
