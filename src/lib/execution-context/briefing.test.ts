import { describe, expect, it } from "vitest";
import { composeInitialWork, composeReview } from "./briefing";
import { initialContextFacts } from "./facts";
import {
  DEFAULT_CONTEXT_POLICY,
  contextContractSchema,
  type ContextFacts,
} from "./schemas";

const seat = {
  profile: { tier: "builtin" as const, id: "standard-agent" },
  backend: "claude" as const,
  modelSelection: { modelId: "sonnet", parameters: {} },
};

function facts(overrides: Record<string, unknown> = {}): ContextFacts {
  return initialContextFacts({
    contextId: "run-1.docs",
    workspace: {
      kind: "session",
      projectPath: "/repo",
      sessionName: "session",
      worktreePath: "/repo/.worktrees/session",
      scope: { mode: "owned", paths: ["docs"] },
    },
    contract: contextContractSchema.parse({
      title: "Document the API",
      brief: "Write the API reference.",
      tasks: [],
      acceptanceCriteria: [],
      outputSchema: null,
      allowTaskAddition: true,
      implementer: { id: "implementer", ...seat },
      reviewers: [],
      checks: [],
      humanApproval: false,
      ownerQuestions: true,
      documents: [],
      ...overrides,
    }),
    policy: DEFAULT_CONTEXT_POLICY,
  });
}

const inputs = [
  { key: "api", title: "Build the API", output: { endpoint: "/v1/notices" } },
  { key: "schema", title: "Write the schema", output: { summary: "Added notice.schema.json." } },
];

const candidate = {
  id: "c-1",
  contractRevision: 1,
  taskRevision: 0,
  output: { summary: "Wrote docs/api.md." },
  evidence: "git:docs",
  provenance: { kind: "work" as const },
};
const round = { id: "r-1", candidateId: "c-1", kind: "full" as const, checks: [], seats: [], retired: false };
const reviewer = { id: "reviewer-1", authority: "blocking" as const, ...seat };

describe("briefing", () => {
  it("gives the implementer the accepted results its work builds on", () => {
    const prompt = composeInitialWork(facts({ inputs }));

    expect(prompt).toContain("## Results this work builds on");
    expect(prompt).toContain("### Build the API (api)");
    expect(prompt).toContain('"endpoint": "/v1/notices"');
    expect(prompt).toContain("### Write the schema");
    expect(prompt).toContain("Added notice.schema.json.");
  });

  it("tells the implementer which whole-tree checks run later instead of on its work", () => {
    const prompt = composeInitialWork(facts({ deferredChecks: ["typecheck", "lint"] }));

    expect(prompt).toMatch(/`typecheck`, `lint`/);
    expect(prompt).toMatch(/assembled/);
  });

  it("omits both sections for a context with neither", () => {
    const prompt = composeInitialWork(facts());

    expect(prompt).not.toContain("Results this work builds on");
    expect(prompt).not.toMatch(/assembled/);
  });

  it("shows reviewers the same inputs the implementer worked from", () => {
    const prompt = composeReview(facts({ inputs }), { candidate, round, seat: reviewer });

    expect(prompt).toContain("### Build the API (api)");
    expect(prompt).toContain('"endpoint": "/v1/notices"');
  });

  it("tells reviewers which changes are this work's and which checks run later, so sibling work is not held against it", () => {
    const prompt = composeReview(facts({ deferredChecks: ["typecheck"] }), { candidate, round, seat: reviewer });

    expect(prompt).toMatch(/may change only `docs`/);
    expect(prompt).toMatch(/`typecheck`[^\n]*assembled/);
  });

  it("says nothing about ownership or deferral to a reviewer of whole-workspace work", () => {
    const whole = initialContextFacts({
      ...facts(),
      contextId: "run-1.agent",
      workspace: { ...facts().binding.request, scope: { mode: "full" } },
      contract: facts().contract.current,
      policy: DEFAULT_CONTEXT_POLICY,
    });
    const prompt = composeReview(whole, { candidate, round, seat: reviewer });

    expect(prompt).not.toMatch(/may change only/);
    expect(prompt).not.toMatch(/assembled/);
  });
});
