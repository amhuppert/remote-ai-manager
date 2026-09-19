// @vitest-environment jsdom
/**
 * The Quality gates group and the validator cohort screens (Config Panel
 * `gatesRows()`, `validatorRows()`, `seatRows()`).
 *
 * The cohort is one block, so every seat edit promotes the whole thing — what
 * these tests pin is that the block boundary is the only thing that moves: the
 * lossless re-enable keeps the dormant roster, a dormant cohort offers no
 * reordering, and a seat edit carries the seats it did not touch through
 * verbatim.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { createTestQueryClient, renderWithQuery } from "@/test/component-mocks";
import { agentProfileKeys } from "@/lib/agent-profiles/query-keys";
import type { AgentProfileLibraryListing } from "@/lib/agent-profiles/schemas";
import type {
  GraphWorkflowExecutionContextDefinition,
  WorkflowConfigOverride,
} from "@/lib/workflow-graph/definition-schemas";
import type {
  ValidatorAssignment,
  ValidatorAuthority,
} from "@/lib/workflow-graph/config-schemas";
import { SEEDED_WORKFLOW_DEFAULTS } from "@/lib/workflow-graph/resolve-config";
import type { ConfigCascadeEditor } from "./cascade-editor";
import { createConfigCascade, type ConfigEditIntent } from "./config-cascade";
import {
  QualityGatesScreen,
  ValidatorCohortScreen,
  ValidatorSeatScreen,
} from "./GatesScreens";
import type { ConfigScope } from "./types";

afterEach(cleanup);

const PROJECT = "checkout";

const LISTING: AgentProfileLibraryListing = {
  profiles: [
    {
      ref: { tier: "builtin", id: "acceptance-criteria-validator" },
      name: "Acceptance Criteria Validator",
      description: "Reviews a diff against the acceptance criteria.",
      revision: 1,
      recommendedFor: ["workflow_validator"],
      tags: [],
      readOnly: true,
    },
    {
      ref: { tier: "project", id: "security-reviewer" },
      name: "Security Reviewer",
      description: "Threat-models the diff.",
      revision: 3,
      recommendedFor: ["workflow_validator"],
      tags: [],
      readOnly: false,
    },
  ],
  diagnostics: [],
};

function seedSeat(): ValidatorAssignment {
  const seeded = SEEDED_WORKFLOW_DEFAULTS.contextValidator.assignments[0];
  if (seeded === undefined) {
    throw new Error("The seeded defaults carry no validator assignment.");
  }
  return seeded;
}

const SEED_SEAT = seedSeat();

/** The seeded reviewer under a use-site id, varying only what a test asserts. */
function seat(overrides: {
  id: string;
  authority?: ValidatorAuthority;
}): ValidatorAssignment {
  const base = structuredClone(SEED_SEAT);
  return {
    ...base,
    id: overrides.id,
    authority: overrides.authority ?? base.authority,
  };
}

function context(
  overrides: Partial<GraphWorkflowExecutionContextDefinition> = {},
): GraphWorkflowExecutionContextDefinition {
  return {
    id: "ctx_checkout",
    title: "Implement checkout",
    acceptanceCriteria: [
      { id: "ac-1", statement: "Every attempt writes exactly one audit row." },
    ],
    placement: { lane: "delivery", mode: "full" },
    ...overrides,
  };
}

function editorFor({
  scope = "context",
  contextOverrides = {},
  workflowConfig = {},
  ...rest
}: {
  scope?: ConfigScope;
  contextOverrides?: Partial<GraphWorkflowExecutionContextDefinition>;
  workflowConfig?: WorkflowConfigOverride;
} & Partial<ConfigCascadeEditor> = {}): {
  editor: ConfigCascadeEditor;
  onEdit: ReturnType<typeof vi.fn<(intent: ConfigEditIntent) => void>>;
} {
  const onEdit = vi.fn<(intent: ConfigEditIntent) => void>();
  return {
    onEdit,
    editor: {
      host: "builder",
      affordance: "editable",
      cascade: createConfigCascade({
        scope,
        globalDefaults: SEEDED_WORKFLOW_DEFAULTS,
        workflowConfig,
        context: context(contextOverrides),
      }),
      onEdit,
      validationCommands: [],
      libraryProjectName: PROJECT,
      ...rest,
    },
  };
}

function renderScreen(ui: React.ReactElement) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(agentProfileKeys.projectList(PROJECT), LISTING);
  return renderWithQuery(ui, queryClient);
}

function setIntents(
  onEdit: ReturnType<typeof vi.fn<(intent: ConfigEditIntent) => void>>,
) {
  return onEdit.mock.calls
    .map(([intent]) => intent)
    .filter((intent) => intent.kind === "set-path");
}

function cohortValue(
  onEdit: ReturnType<typeof vi.fn<(intent: ConfigEditIntent) => void>>,
) {
  const intent = setIntents(onEdit)[0];
  if (intent?.path !== "contextValidator") {
    throw new Error(`Expected a contextValidator write, got ${intent?.path}`);
  }
  return intent.value;
}

describe("Quality gates group screen", () => {
  it("groups the gates as agent review, command gates and human gates", () => {
    const { editor } = editorFor();
    renderScreen(<QualityGatesScreen editor={editor} onOpen={vi.fn()} />);

    for (const label of ["Agent review", "Command gates", "Human gates"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    expect(screen.getByTestId("config-row-validator")).toBeInTheDocument();
    expect(screen.getByTestId("config-row-script")).toBeInTheDocument();
    expect(screen.getByTestId("config-row-agentval")).toBeInTheDocument();
  });

  it("offers lane-merge validation on workflow scope only", () => {
    const { editor: contextEditor } = editorFor({ scope: "context" });
    renderScreen(
      <QualityGatesScreen editor={contextEditor} onOpen={vi.fn()} />,
    );
    expect(screen.queryByTestId("config-row-lanemerge")).toBeNull();

    cleanup();

    const { editor: workflowEditor } = editorFor({ scope: "workflow" });
    renderScreen(
      <QualityGatesScreen editor={workflowEditor} onOpen={vi.fn()} />,
    );
    expect(screen.getByTestId("config-row-lanemerge")).toBeInTheDocument();
  });

  it("says what an approval does and does not do", () => {
    const { editor } = editorFor();
    renderScreen(<QualityGatesScreen editor={editor} onOpen={vi.fn()} />);

    expect(
      screen.getByTestId("config-row-human-approval-gate").textContent,
    ).toContain(
      "Approval lets orchestration continue; it does not itself land or publish the lane",
    );
    expect(
      screen.getByTestId("config-row-ask-user-questions"),
    ).toBeInTheDocument();
  });

  it("keeps the roster when the cohort is switched off, and notes it is dormant", () => {
    const { editor, onEdit } = editorFor();
    renderScreen(<QualityGatesScreen editor={editor} onOpen={vi.fn()} />);

    expect(screen.queryByTestId("config-row-cohort-dormant")).toBeNull();

    fireEvent.click(
      within(
        screen.getByTestId("config-row-validator-cohort-enabled"),
      ).getByRole("switch"),
    );

    expect(cohortValue(onEdit)).toMatchObject({
      enabled: false,
      assignments: SEEDED_WORKFLOW_DEFAULTS.contextValidator.assignments,
    });
  });

  it("restores a seat when an emptied cohort is switched back on", () => {
    const { editor, onEdit } = editorFor({
      contextOverrides: {
        contextValidator: { enabled: false, assignments: [] },
      },
    });
    renderScreen(<QualityGatesScreen editor={editor} onOpen={vi.fn()} />);

    expect(
      screen.getByTestId("config-row-cohort-dormant").textContent,
    ).toContain("restored when the cohort is switched back on");

    fireEvent.click(
      within(
        screen.getByTestId("config-row-validator-cohort-enabled"),
      ).getByRole("switch"),
    );

    const next = cohortValue(onEdit);
    expect(next.enabled).toBe(true);
    expect(next.assignments).toHaveLength(1);
  });
});

describe("Validator cohort roster screen", () => {
  it("lists the seats in order with authority and agent", () => {
    const { editor } = editorFor({
      contextOverrides: {
        contextValidator: {
          enabled: true,
          assignments: [
            seat({ id: "general" }),
            seat({ id: "security", authority: "advisory" }),
          ],
        },
      },
    });
    renderScreen(<ValidatorCohortScreen editor={editor} onOpen={vi.fn()} />);

    const security = screen.getByTestId("config-item-security");
    expect(security.textContent).toContain("advisory");
    // The selector holds the short id `sonnet`; the reader sees the catalog's
    // canonical name (README §3.3).
    expect(security.textContent).toContain("Sonnet");
    expect(security.textContent).not.toMatch(/\bsonnet\b/);
    expect(security.textContent).toContain(
      `${SEED_SEAT.profile.id} · effort=medium`,
    );
  });

  it("reorders a seat without disturbing the others", () => {
    const { editor, onEdit } = editorFor({
      contextOverrides: {
        contextValidator: {
          enabled: true,
          assignments: [seat({ id: "general" }), seat({ id: "security" })],
        },
      },
    });
    renderScreen(<ValidatorCohortScreen editor={editor} onOpen={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Move security up" }));

    expect(cohortValue(onEdit)).toMatchObject({
      assignments: [{ id: "security" }, { id: "general" }],
    });
  });

  it("keeps a dormant roster visible but not reorderable", () => {
    const { editor } = editorFor({
      contextOverrides: {
        contextValidator: {
          enabled: false,
          assignments: [seat({ id: "general" }), seat({ id: "security" })],
        },
      },
    });
    renderScreen(<ValidatorCohortScreen editor={editor} onOpen={vi.fn()} />);

    expect(screen.getByTestId("config-item-security")).toBeInTheDocument();
    expect(screen.getByTestId("config-row-cohort-seats").textContent).toContain(
      "Dormant — configuration to restore, not work to dispatch.",
    );
    expect(
      screen.getByRole("button", { name: "Move security up" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Add validator" }),
    ).toBeDisabled();
  });

  it("refuses to remove the last seat of an enabled cohort", () => {
    const { editor } = editorFor();
    renderScreen(<ValidatorCohortScreen editor={editor} onOpen={vi.fn()} />);

    expect(
      screen.getByRole("button", { name: `Remove ${SEED_SEAT.id}` }),
    ).toBeDisabled();
  });

  it("seeds an added validator from the shipped defaults under a fresh id", () => {
    const { editor, onEdit } = editorFor();
    renderScreen(<ValidatorCohortScreen editor={editor} onOpen={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Add validator" }));

    const next = cohortValue(onEdit);
    expect(next.assignments).toHaveLength(2);
    const added = next.assignments[1];
    expect(added?.id).not.toBe(next.assignments[0]?.id);
    expect(added).toMatchObject({
      profile: SEED_SEAT.profile,
      authority: SEED_SEAT.authority,
      agent: SEED_SEAT.agent,
    });
  });

  it("opens the seat screen from the roster", () => {
    const onOpen = vi.fn();
    const { editor } = editorFor();
    renderScreen(<ValidatorCohortScreen editor={editor} onOpen={onOpen} />);

    fireEvent.click(
      within(screen.getByTestId(`config-item-${SEED_SEAT.id}`)).getByRole(
        "button",
        { name: new RegExp(`^${SEED_SEAT.id}`) },
      ),
    );

    expect(onOpen).toHaveBeenCalledWith(`seat:${SEED_SEAT.id}`);
  });
});

describe("Validator seat screen", () => {
  const twoSeats = {
    contextValidator: {
      enabled: true,
      assignments: [
        seat({ id: "general" }),
        seat({ id: "security", authority: "advisory" }),
      ],
    },
  } satisfies Partial<GraphWorkflowExecutionContextDefinition>;

  it("names the force of the instructions field from the seat's authority", () => {
    const { editor } = editorFor({ contextOverrides: twoSeats });
    renderScreen(<ValidatorSeatScreen editor={editor} seatId="general" />);

    const row = screen.getByTestId("config-row-seat-instructions");
    expect(row.textContent).toContain("Mandate");

    cleanup();

    const advisory = editorFor({ contextOverrides: twoSeats });
    renderScreen(
      <ValidatorSeatScreen editor={advisory.editor} seatId="security" />,
    );
    expect(
      screen.getByTestId("config-row-seat-instructions").textContent,
    ).not.toContain("Mandate");
  });

  it("states what each authority decides", () => {
    const { editor } = editorFor({ contextOverrides: twoSeats });
    renderScreen(<ValidatorSeatScreen editor={editor} seatId="general" />);

    expect(
      screen.getByTestId("config-row-seat-authority").textContent,
    ).toContain("A blocking verdict reopens tasks and can fail the context.");
  });

  it("edits one seat and carries its siblings through untouched", () => {
    const { editor, onEdit } = editorFor({ contextOverrides: twoSeats });
    renderScreen(<ValidatorSeatScreen editor={editor} seatId="security" />);

    fireEvent.click(
      within(screen.getByTestId("config-row-seat-authority")).getByRole(
        "radio",
        { name: "blocking" },
      ),
    );

    expect(cohortValue(onEdit)).toMatchObject({
      enabled: true,
      assignments: [
        { id: "general", authority: "blocking" },
        { id: "security", authority: "blocking" },
      ],
    });
    expect(setIntents(onEdit)[0]).toMatchObject({ granularity: "block" });
  });

  it("locks every control when the affordance is not editable", () => {
    const { editor } = editorFor({ affordance: "frozen" });
    renderScreen(<ValidatorSeatScreen editor={editor} seatId={SEED_SEAT.id} />);

    expect(screen.getByRole("radio", { name: "blocking" })).toBeDisabled();
  });

  it("offers the narrow per-seat reset only when the host supplies one", () => {
    const { editor } = editorFor({ contextOverrides: twoSeats });
    renderScreen(<ValidatorSeatScreen editor={editor} seatId="security" />);
    expect(screen.queryByTestId("config-row-seat-reset")).toBeNull();
    cleanup();

    const onResetSeat = vi.fn<(seatId: string) => void>();
    const resettable = editorFor({ contextOverrides: twoSeats, onResetSeat });
    renderScreen(
      <ValidatorSeatScreen editor={resettable.editor} seatId="security" />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Reset seat" }));
    expect(onResetSeat).toHaveBeenCalledWith("security");
  });

  it("shows the in-flight reset and refuses a second one", () => {
    const onResetSeat = vi.fn<(seatId: string) => void>();
    const { editor } = editorFor({
      contextOverrides: twoSeats,
      onResetSeat,
      resettingSeatId: "security",
    });
    renderScreen(<ValidatorSeatScreen editor={editor} seatId="security" />);

    expect(screen.getByRole("button", { name: "Resetting…" })).toBeDisabled();
  });
});

it("locks a started validator while retaining edits for an unstarted seat", () => {
  const { editor } = editorFor({
    contextOverrides: {
      contextValidator: {
        enabled: true,
        assignments: [seat({ id: "general" }), seat({ id: "security" })],
      },
    },
    startedLaneKeys: new Set(["context_validator:security"]),
  });
  renderScreen(<ValidatorSeatScreen editor={editor} seatId="security" />);
  expect(screen.getByRole("radio", { name: "advisory" })).toBeDisabled();
  expect(screen.getByLabelText("Agent profile")).toBeDisabled();
  cleanup();
  renderScreen(<ValidatorSeatScreen editor={editor} seatId="general" />);
  expect(screen.getByRole("radio", { name: "advisory" })).not.toBeDisabled();
});
