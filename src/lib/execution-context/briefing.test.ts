import { describe, expect, it } from "vitest";
import {
  composeAdvice,
  composeInitialWork,
  composeRemediation,
  composeRetryWork,
  composeReview,
  composeRework,
  composeSteer,
} from "./briefing";
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
  {
    key: "schema",
    title: "Write the schema",
    output: { summary: "Added notice.schema.json." },
  },
];

const candidate = {
  id: "c-1",
  contractRevision: 1,
  taskRevision: 0,
  output: { summary: "Wrote docs/api.md." },
  evidence: "git:docs",
  provenance: { kind: "work" as const },
};
const round = {
  id: "r-1",
  candidateId: "c-1",
  kind: "full" as const,
  checks: [],
  seats: [],
  retired: false,
};
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
    const prompt = composeInitialWork(
      facts({ deferredChecks: ["typecheck", "lint"] }),
    );

    expect(prompt).toMatch(/`typecheck`, `lint`/);
    expect(prompt).toMatch(/assembled/);
  });

  it("omits both sections for a context with neither", () => {
    const prompt = composeInitialWork(facts());

    expect(prompt).not.toContain("Results this work builds on");
    expect(prompt).not.toMatch(/assembled/);
  });

  it("shows reviewers the same inputs the implementer worked from", () => {
    const prompt = composeReview(facts({ inputs }), {
      candidate,
      round,
      seat: reviewer,
    });

    expect(prompt).toContain("### Build the API (api)");
    expect(prompt).toContain('"endpoint": "/v1/notices"');
  });

  it("tells reviewers which changes are this work's and which checks run later, so sibling work is not held against it", () => {
    const prompt = composeReview(facts({ deferredChecks: ["typecheck"] }), {
      candidate,
      round,
      seat: reviewer,
    });

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

  const charter = {
    revision: 1,
    mission: "Make the failure notice appear once.",
    nonGoals: ["Networked filesystems"],
    invariants: [
      { id: "no-mocks", statement: "No vi.mock of internal modules." },
    ],
    sourcesOfTruth: [
      {
        rank: 1,
        id: "spec",
        label: "Spec",
        type: "spec" as const,
        locator: "specs/notice.md",
        description: "The notice spec",
      },
    ],
    documentPath: ".cc/run-docs/run-1.docs/charter.md",
  };

  it("leads the implementer's first order with the charter that governs it, and asks it to keep the invariants and cite sources", () => {
    const prompt = composeInitialWork(facts({ charter }));

    expect(prompt.indexOf("## Charter")).toBeLessThan(
      prompt.indexOf("## Tasks"),
    );
    expect(prompt).toContain("Make the failure notice appear once.");
    expect(prompt).toContain("`no-mocks`: No vi.mock of internal modules.");
    expect(prompt).toContain("1. Spec (`specs/notice.md`): The notice spec");
    expect(prompt).toContain("Networked filesystems");
    expect(prompt).toContain("`.cc/run-docs/run-1.docs/charter.md`");
    expect(prompt).toMatch(/cite the governing source/);
    expect(prompt).toMatch(/non-goal/);
  });

  it("asks a reviewer to check each invariant and cite its id", () => {
    const prompt = composeReview(facts({ charter }), {
      candidate,
      round,
      seat: reviewer,
    });

    expect(prompt).toContain("`no-mocks`: No vi.mock of internal modules.");
    expect(prompt).toMatch(/cite the invariant's id/);
  });

  it("has the implementer cite and decline in the message that ends its turn, and check invariants concretely", () => {
    const prompt = composeInitialWork(facts({ charter }));

    expect(prompt).not.toMatch(/task summary/);
    expect(prompt).toMatch(
      /cite the governing source in the message that ends your turn/,
    );
    expect(prompt).toMatch(/decline it in the message that ends your turn/);
    expect(prompt).toMatch(/with a concrete check/);
  });

  it("bounds a blocking reviewer by the charter: out-of-mission findings are advice, outcomes keep process invariants, and a criterion against a higher source is a plan defect", () => {
    const prompt = composeReview(facts({ charter }), {
      candidate,
      round,
      seat: reviewer,
    });

    expect(prompt).toMatch(
      /only under a non-goal or outside the mission is advice, never a blocking finding/,
    );
    expect(prompt).toMatch(
      /how the work was produced is kept when the outcome it protects holds/,
    );
    expect(prompt).toMatch(
      /contradicts a higher-ranked source[^\n]*`plan_defect`/,
    );

    const advisory = composeReview(facts({ charter }), {
      candidate,
      round,
      seat: { ...reviewer, authority: "advisory" },
    });
    expect(advisory).toMatch(/never a blocking finding/);
    expect(advisory).not.toMatch(/contradicts a higher-ranked source/);
  });

  it("shows a reviewer of structured work the implementer's closing report, where its citations and declines are", () => {
    const structured = facts({ charter, outputSchema: { type: "object" } });
    const reported = {
      ...structured,
      ledger: {
        ...structured.ledger,
        lastSummary: "Declined NFS locking: a non-goal.",
      },
    };
    const prompt = composeReview(reported, {
      candidate: { ...candidate, output: { pages: 3 } },
      round,
      seat: reviewer,
    });

    expect(prompt).toContain("## The implementer's closing report");
    expect(prompt).toContain("Declined NFS locking: a non-goal.");

    const plain = facts({ charter });
    const summarized = {
      ...plain,
      ledger: { ...plain.ledger, lastSummary: "Wrote docs/api.md." },
    };
    expect(
      composeReview(summarized, { candidate, round, seat: reviewer }),
    ).not.toContain("closing report");
  });

  const charterDocument = {
    artifactId: `sha256:${"c".repeat(64)}`,
    path: ".cc/run-docs/run-1.docs/charter.md",
    description: "The run's charter as it governs this work.",
    readWhen: "Before you start",
  };
  const plan = {
    artifactId: `sha256:${"d".repeat(64)}`,
    path: ".cc/run-docs/run-1.docs/plan.md",
    description: "The plan.",
  };

  it("points every later order at the charter that still governs and the frozen documents, for a seat that never saw the first", () => {
    const governed = facts({ charter, documents: [charterDocument, plan] });
    const finding = { title: "Wrong code", description: "It returns 500" };
    const orders = {
      retry: composeRetryWork(governed),
      remediation: composeRemediation(governed, [finding], []),
      rework: composeRework(governed, null),
      steer: composeSteer(governed, "Also cover errors."),
      advice: composeAdvice(governed, [
        {
          id: "a-1",
          roundId: "r-1",
          assignmentId: "reviewer-1",
          title: "Rename",
          description: "Clearer name",
        },
      ]),
    };
    for (const [order, prompt] of Object.entries(orders)) {
      expect(prompt, order).toContain("## Charter and documents");
      expect(prompt, order).toMatch(/charter still governs/);
      expect(prompt, order).toContain("`.cc/run-docs/run-1.docs/plan.md`");
    }

    const plain = facts();
    expect(composeRetryWork(plain)).not.toContain("## Charter and documents");
    const documented = composeRetryWork(facts({ documents: [plan] }));
    expect(documented).toContain("## Charter and documents");
    expect(documented).not.toMatch(/charter still governs/);
  });

  it("lets remediation decline a finding outside the charter's mission, asking only when the contract allows questions", () => {
    const finding = { title: "Not NFS-safe", description: "Locks fail on NFS" };
    const prompt = composeRemediation(
      facts({ charter, documents: [charterDocument] }),
      [finding],
      [],
    );
    expect(prompt).toMatch(
      /not yours to build: decline it in the message that ends your turn/,
    );
    expect(prompt).toMatch(/ask if you cannot tell/);

    const silent = composeRemediation(
      facts({ charter, documents: [charterDocument], ownerQuestions: false }),
      [finding],
      [],
    );
    expect(silent).not.toMatch(/ask if you cannot tell/);
  });

  it("tells a workflow context's implementer it can publish documents for later work, and no one else", () => {
    const publishing = facts({ documentPublishing: true });
    expect(composeInitialWork(publishing)).toMatch(
      /`cctl context doc publish <file>`/,
    );
    expect(composeInitialWork(publishing)).toMatch(
      /work already running keeps the revision it started with/,
    );
    expect(composeInitialWork(facts())).not.toMatch(/doc publish/);
    expect(
      composeReview(publishing, { candidate, round, seat: reviewer }),
    ).not.toMatch(/doc publish/);
  });

  it("says nothing about a charter to work without one", () => {
    expect(composeInitialWork(facts())).not.toContain("## Charter");
  });
});
