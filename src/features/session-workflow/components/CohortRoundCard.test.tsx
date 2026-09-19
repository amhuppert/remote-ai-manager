// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import type { ValidatorAssignment } from "@/lib/workflow-graph/config-schemas";
import type { GraphWorkflowValidationIncidentEvent } from "@/lib/workflow-graph/event-schemas";
import type {
  GraphWorkflowAdvisoryResponsePhase,
  GraphWorkflowValidationAdvisory,
  GraphWorkflowValidationRound,
  GraphWorkflowValidationSpecialist,
} from "@/lib/workflow-graph/schemas";
import { makeValidatorAssignment } from "@/lib/workflow-graph/test-fixtures";
import CohortRoundCard from "./CohortRoundCard";
import { deriveCohortRoundView } from "./cohort-round-view";

function advisory(
  overrides: Partial<GraphWorkflowValidationAdvisory> = {},
): GraphWorkflowValidationAdvisory {
  return {
    kind: "implementation",
    title: "Extract the retry budget",
    description: "The retry budget is recomputed in three call sites.",
    identity: { roundSeq: 2, assignmentId: "security", ordinal: 1 },
    deliveredAt: null,
    disposition: null,
    ...overrides,
  };
}

function specialist(
  overrides: Partial<GraphWorkflowValidationSpecialist> = {},
): GraphWorkflowValidationSpecialist {
  return {
    state: "verdict_pass",
    attempts: 1,
    summary: "Nothing blocking.",
    issues: [],
    advisories: [],
    questionToken: null,
    sessionRef: null,
    reviewArtifact: null,
    lastInfraFailure: null,
    ...overrides,
  };
}

function round(
  overrides: Partial<GraphWorkflowValidationRound> = {},
): GraphWorkflowValidationRound {
  return {
    seq: 2,
    candidate: {
      identityScope: "wholeTree",
      headSha: "head-1",
      candidateTreeHash: "treehash-1",
      taskStateHash: "tasks-1",
    },
    roster: [
      {
        assignmentId: "acceptance-criteria",
        profileRef: { tier: "builtin", id: "acceptance-verifier" },
        revision: 1,
        resolvedInstructionHash: `sha256:${"a".repeat(64)}`,
      },
      {
        assignmentId: "security",
        profileRef: { tier: "project", id: "security-reviewer" },
        revision: 4,
        resolvedInstructionHash: `sha256:${"c".repeat(64)}`,
      },
    ],
    specialists: {
      "acceptance-criteria": specialist(),
      security: specialist(),
    },
    phase: "concluded",
    outcome: "passed",
    startedAt: "2026-03-27T10:00:00.000Z",
    ...overrides,
  };
}

/** The live cohort: a blocking seeded verifier plus one authored advisory seat. */
function assignments(): ValidatorAssignment[] {
  return [
    makeValidatorAssignment({
      id: "acceptance-criteria",
      authority: "blocking",
    }),
    makeValidatorAssignment({ id: "security", authority: "advisory" }),
  ];
}

function renderCard(input: {
  round: GraphWorkflowValidationRound;
  incidents?: readonly (GraphWorkflowValidationIncidentEvent & {
    occurredAt: string;
  })[];
  advisoryResponse?: GraphWorkflowAdvisoryResponsePhase | null;
  assignments?: readonly ValidatorAssignment[];
}) {
  const view = deriveCohortRoundView({
    round: input.round,
    incidents: input.incidents ?? [],
    assignments: input.assignments ?? assignments(),
    advisoryResponse: input.advisoryResponse ?? null,
  });
  if (view === null) throw new Error("expected a round view");
  return render(<CohortRoundCard view={view} />);
}

function memberRow(assignmentId: string): HTMLElement {
  const row = screen
    .getAllByTestId("cohort-member")
    .find((el) => el.getAttribute("data-assignment-id") === assignmentId);
  if (!row) throw new Error(`no member row for ${assignmentId}`);
  return row;
}

describe("CohortRoundCard — advisories vs blocking issues (R9.2)", () => {
  it("renders each advisory's kind as a tone-coded chip", () => {
    renderCard({
      round: round({
        specialists: {
          "acceptance-criteria": specialist(),
          security: specialist({
            advisories: [
              advisory({ kind: "implementation", title: "Extract the budget" }),
              advisory({
                kind: "plan",
                title: "The plan skips a migration",
                identity: {
                  roundSeq: 2,
                  assignmentId: "security",
                  ordinal: 2,
                },
              }),
              advisory({
                kind: "out_of_scope",
                title: "Unrelated dead route",
                identity: {
                  roundSeq: 2,
                  assignmentId: "security",
                  ordinal: 3,
                },
              }),
            ],
          }),
        },
      }),
    });

    const kinds = screen.getAllByTestId("cohort-advisory-kind");
    expect(
      kinds.map((chip) => [chip.textContent, chip.getAttribute("data-tone")]),
    ).toEqual([
      ["Implementation", "cyan"],
      ["Plan", "amber"],
      ["Out of scope", "neutral"],
    ]);
  });

  it("never renders an advisory in the failure tone reserved for blocking issues", () => {
    renderCard({
      round: round({
        outcome: "failed",
        specialists: {
          "acceptance-criteria": specialist({
            state: "verdict_fail",
            summary: "Criterion 2 is unmet.",
            issues: [
              {
                taskId: "task-1",
                title: "Criterion 2 unmet",
                description: "No test covers it.",
              },
            ],
          }),
          security: specialist({
            advisories: [advisory({ kind: "plan", title: "Plan drift" })],
          }),
        },
      }),
    });

    // Red is the blocking-issue tone. An advisory that borrowed it — on the
    // entry itself or on anything nested in it — would read as a finding that
    // failed the round.
    for (const entry of screen.getAllByTestId("cohort-advisory")) {
      expect(entry.querySelectorAll('[data-tone="red"]')).toHaveLength(0);
      expect(entry.getAttribute("data-tone")).not.toBe("red");
    }
    // The blocking lane still reads as a rejection, so the contrast is real.
    expect(
      within(memberRow("acceptance-criteria"))
        .getByTestId("cohort-member-state")
        .getAttribute("data-tone"),
    ).toBe("red");
  });

  it("separates a lane's advisories from its blocking issues", () => {
    renderCard({
      round: round({
        specialists: {
          "acceptance-criteria": specialist(),
          security: specialist({
            advisories: [advisory({ title: "Extract the budget" })],
          }),
        },
      }),
    });

    const security = within(memberRow("security"));
    expect(security.getByText("Extract the budget")).toBeInTheDocument();
    expect(
      security.getByText("The retry budget is recomputed in three call sites."),
    ).toBeInTheDocument();
    // The advisory belongs to the lane that raised it, not to the round.
    expect(
      within(memberRow("acceptance-criteria")).queryByTestId("cohort-advisory"),
    ).toBeNull();
  });
});

describe("CohortRoundCard — advisory dispositions (R9.3)", () => {
  it("renders a distinct pending state while no disposition exists", () => {
    renderCard({
      round: round({
        specialists: {
          "acceptance-criteria": specialist(),
          security: specialist({
            advisories: [advisory({ deliveredAt: "2026-03-27T10:05:00.000Z" })],
          }),
        },
      }),
    });

    const disposition = screen.getByTestId("cohort-advisory-disposition");
    expect(disposition).toHaveAttribute("data-disposition", "pending");
    expect(disposition).toHaveTextContent("No disposition");
  });

  it("renders each recorded disposition, with the implementer's reason on a decline", () => {
    renderCard({
      round: round({
        specialists: {
          "acceptance-criteria": specialist(),
          security: specialist({
            advisories: [
              advisory({
                title: "Extract the budget",
                deliveredAt: "2026-03-27T10:05:00.000Z",
                disposition: {
                  outcome: "addressed",
                  reason: null,
                  recordedAt: "2026-03-27T10:20:00.000Z",
                },
              }),
              advisory({
                title: "Rename the lane key",
                identity: {
                  roundSeq: 2,
                  assignmentId: "security",
                  ordinal: 2,
                },
                deliveredAt: "2026-03-27T10:05:00.000Z",
                disposition: {
                  outcome: "declined",
                  reason: "The key is persisted; renaming it breaks resume.",
                  recordedAt: "2026-03-27T10:20:00.000Z",
                },
              }),
              advisory({
                title: "Split the migration",
                identity: {
                  roundSeq: 2,
                  assignmentId: "security",
                  ordinal: 3,
                },
                deliveredAt: "2026-03-27T10:05:00.000Z",
                disposition: {
                  outcome: "deferred",
                  reason: null,
                  recordedAt: "2026-03-27T10:20:00.000Z",
                },
              }),
            ],
          }),
        },
      }),
    });

    const dispositions = screen.getAllByTestId("cohort-advisory-disposition");
    expect(
      dispositions.map((el) => [
        el.getAttribute("data-disposition"),
        el.getAttribute("data-tone"),
      ]),
    ).toEqual([
      ["addressed", "green"],
      ["declined", "cyan"],
      ["deferred", "amber"],
    ]);
    expect(
      screen.getByText("The key is persisted; renaming it breaks resume."),
    ).toBeInTheDocument();
  });
});

describe("CohortRoundCard — specialist authority (R9.5)", () => {
  it("carries a tone-coded authority badge on every specialist row", () => {
    renderCard({ round: round() });

    const blocking = within(memberRow("acceptance-criteria")).getByTestId(
      "cohort-member-authority",
    );
    expect(blocking).toHaveTextContent("Blocking");
    expect(blocking).toHaveAttribute("data-tone", "amber");

    const advisoryBadge = within(memberRow("security")).getByTestId(
      "cohort-member-authority",
    );
    expect(advisoryBadge).toHaveTextContent("Advisory");
    expect(advisoryBadge).toHaveAttribute("data-tone", "neutral");
  });

  it("does not claim an authority for a seat the live cohort no longer holds", () => {
    renderCard({
      round: round(),
      assignments: [
        makeValidatorAssignment({
          id: "acceptance-criteria",
          authority: "blocking",
        }),
      ],
    });

    expect(
      within(memberRow("security")).getByTestId("cohort-member-authority"),
    ).toHaveTextContent("Authority unknown");
  });

  it("renders an advisory lane's infra exhaustion as recorded-informational on a concluded round", () => {
    renderCard({
      round: round({
        phase: "concluded",
        outcome: "passed",
        specialists: {
          "acceptance-criteria": specialist(),
          security: specialist({
            state: "infra_failed",
            attempts: 3,
            summary: null,
            lastInfraFailure: {
              reason: "exception",
              message: "Backend refused the lane three times",
              engine: "claude",
            },
          }),
        },
      }),
      incidents: [
        {
          occurredAt: "2026-03-27T10:04:00.000Z",
          type: "graph-workflow-validation-incident",
          projectName: "project",
          sessionName: "session",
          executionId: "execution-1",
          contextId: "context-plan",
          incident: "infra_exhausted",
          roundSeq: 2,
          stage: "specialist_result",
          assignmentId: "security",
          attempts: 3,
          driftedComponents: "",
          message: "Backend refused the lane three times",
        },
      ],
    });

    // The round concluded and passed; the advisory lane's exhaustion is a
    // recorded fact about that lane, not a verdict on the work.
    const aggregate = screen.getByTestId("cohort-round-aggregate");
    expect(aggregate).toHaveTextContent("Cohort passed");
    expect(aggregate).toHaveAttribute("data-outcome-kind", "semantic");

    const state = within(memberRow("security")).getByTestId(
      "cohort-member-state",
    );
    expect(state).toHaveTextContent("Infrastructure failure — recorded");
    expect(state.getAttribute("data-tone")).not.toBe("red");
    expect(state).toHaveAttribute("data-tone", "neutral");
    expect(memberRow("security")).toHaveAttribute("data-blocks-round", "false");

    const incident = screen.getByTestId("cohort-incident");
    expect(incident).toHaveAttribute("data-blocks-round", "false");
    expect(
      within(incident)
        .getByTestId("cohort-incident-tone")
        .getAttribute("data-tone"),
    ).toBe("neutral");
  });

  it("keeps a blocking lane's infra exhaustion in the round-blocking tone", () => {
    renderCard({
      round: round({
        phase: "specialists",
        outcome: null,
        specialists: {
          "acceptance-criteria": specialist({
            state: "infra_failed",
            summary: null,
            attempts: 3,
            lastInfraFailure: {
              reason: "exception",
              message: "Backend refused the lane three times",
              engine: "claude",
            },
          }),
          security: specialist(),
        },
      }),
    });

    const state = within(memberRow("acceptance-criteria")).getByTestId(
      "cohort-member-state",
    );
    expect(state).toHaveTextContent("Infrastructure failure");
    expect(state).toHaveAttribute("data-tone", "amber");
    expect(memberRow("acceptance-criteria")).toHaveAttribute(
      "data-blocks-round",
      "true",
    );
  });
});

describe("CohortRoundCard — round timeline (R6.3)", () => {
  it("marks the concluded step current for a passing round that owes no response", () => {
    renderCard({ round: round() });

    const steps = screen.getAllByTestId("cohort-round-step");
    expect(
      steps.map((step) => [
        step.getAttribute("data-step"),
        step.getAttribute("data-state"),
      ]),
    ).toEqual([
      ["script", "done"],
      ["specialists", "done"],
      ["concluded", "current"],
    ]);
  });

  it("marks the specialists step current while the cohort is still reviewing", () => {
    renderCard({ round: round({ phase: "specialists", outcome: null }) });

    const steps = screen.getAllByTestId("cohort-round-step");
    expect(
      steps.map((step) => [
        step.getAttribute("data-step"),
        step.getAttribute("data-state"),
      ]),
    ).toEqual([
      ["script", "done"],
      ["specialists", "current"],
      ["concluded", "upcoming"],
    ]);
  });

  it("adds an advisory-response step, current and distinct from concluded, while the turn is owed", () => {
    renderCard({
      round: round(),
      advisoryResponse: {
        roundSeq: 2,
        phase: "awaiting_response",
        enteredAt: "2026-03-27T10:10:00.000Z",
      },
    });

    const steps = screen.getAllByTestId("cohort-round-step");
    expect(
      steps.map((step) => [
        step.getAttribute("data-step"),
        step.getAttribute("data-state"),
      ]),
    ).toEqual([
      ["script", "done"],
      ["specialists", "done"],
      ["concluded", "done"],
      ["advisory_response", "current"],
    ]);
    expect(screen.getByText("Advisory response")).toBeInTheDocument();
  });

  it("retires the advisory-response step once the response turn moved the candidate", () => {
    renderCard({
      round: round(),
      advisoryResponse: {
        roundSeq: 2,
        phase: "recertifying",
        enteredAt: "2026-03-27T10:10:00.000Z",
      },
    });

    const steps = screen.getAllByTestId("cohort-round-step");
    expect(steps[steps.length - 1]).toHaveAttribute(
      "data-step",
      "advisory_response",
    );
    expect(steps[steps.length - 1]).toHaveAttribute("data-state", "done");
  });

  it("keeps an earlier round's advisory-response phase off this round's timeline", () => {
    renderCard({
      round: round({ seq: 3 }),
      advisoryResponse: {
        roundSeq: 2,
        phase: "awaiting_response",
        enteredAt: "2026-03-27T10:10:00.000Z",
      },
    });

    expect(
      screen
        .getAllByTestId("cohort-round-step")
        .map((step) => step.getAttribute("data-step")),
    ).toEqual(["script", "specialists", "concluded"]);
  });
});
