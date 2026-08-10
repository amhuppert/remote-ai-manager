// @vitest-environment jsdom
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture, type FetchFixture } from "@/test/fetch-fixture";
import type { SpecDetailView } from "@/lib/specs/queries";

import { specElementReaderDetailFixture } from "./SpecElementReader.fixtures";
import { SpecElementReader } from "./SpecElementReader";

const PROJECT = "command-center";
const REMOVE_PATH = "/api/specs/command-center/native-sdd/actions/draft-remove";

/**
 * The reader with the query provider its draft-removal mutation needs. Every
 * render goes through it so the surface under test is the wired one.
 */
function renderReader(
  detail: SpecDetailView,
  kind: "requirements" | "decisions" | "tasks",
) {
  return renderWithQuery(
    <SpecElementReader detail={detail} kind={kind} projectName={PROJECT} />,
  );
}

/**
 * The fixture's current revision reopened as an editable draft — the only
 * state in which an element may be taken out, since approved content is
 * immutable.
 */
function draftDetailFixture(): SpecDetailView {
  const detail = specElementReaderDetailFixture();
  const snapshot = detail.currentRevision;
  if (snapshot === null) throw new Error("Reader fixture requires a revision");
  detail.currentRevision = {
    revision: {
      ...snapshot.revision,
      id: "revision-2",
      number: 2,
      state: "draft",
      basedOnRevisionId: snapshot.revision.id,
      proposedAt: null,
      approvedAt: null,
    },
    elements: snapshot.elements.map((entry) => ({
      ...entry,
      version: { ...entry.version, revisionId: "revision-2" },
    })),
  };
  return detail;
}

let api: FetchFixture;

beforeEach(() => {
  api = installFetchFixture();
});

afterEach(() => {
  api.restore();
  cleanup();
});

describe("SpecElementReader", () => {
  it("renders authored prose as markdown across requirement, decision, and task readers", async () => {
    const detail = specElementReaderDetailFixture();
    const snapshot = detail.currentRevision;
    if (snapshot === null)
      throw new Error("Reader fixture requires a revision");
    for (const entry of snapshot.elements) {
      const payload = entry.version.payload;
      if (payload.kind === "requirement") {
        payload.statement = "Every **execution** pins scope.";
      } else if (payload.kind === "criterion") {
        payload.text = "- Pin the selected `task`\n- Pin the criterion";
        payload.validationStrategy.note = "Run the **scope test**.";
      } else if (payload.kind === "decision") {
        payload.chosenApproach = "Persist the **selected scope**.";
        payload.reason = "1. Keep runs reproducible\n2. Keep review auditable";
        payload.rejectedAlternatives[0]!.reason =
          "The source `revision` could change.";
      } else if (payload.kind === "task" && entry.element.id === "task-2") {
        payload.instructions = "- Read the pinned snapshot\n- **Verify** it";
      }
    }

    const requirementView = renderReader(detail, "requirements");
    const decisionView = renderReader(detail, "decisions");
    const taskView = renderReader(detail, "tasks");

    expect(
      await within(requirementView.container).findByText("execution", {
        selector: "strong",
      }),
    ).toBeVisible();
    expect(
      await within(requirementView.container).findByText("task", {
        selector: "code",
      }),
    ).toBeVisible();
    expect(
      await within(requirementView.container).findByText("scope test", {
        selector: "strong",
      }),
    ).toBeVisible();
    expect(
      await within(decisionView.container).findByText("selected scope", {
        selector: "strong",
      }),
    ).toBeVisible();
    expect(
      await within(decisionView.container).findByText("revision", {
        selector: "code",
      }),
    ).toBeVisible();
    expect(
      await within(taskView.container).findByText("Verify", {
        selector: "strong",
      }),
    ).toBeVisible();
  });

  it("reads requirements from the current revision with their criteria and status", () => {
    const detail = specElementReaderDetailFixture();
    const approved = detail.currentApprovedRevision;
    if (approved === null) throw new Error("Reader fixture requires approval");
    const draftRevision = {
      ...approved.revision,
      id: "revision-2",
      number: 2,
      state: "draft" as const,
      basedOnRevisionId: approved.revision.id,
      contentHash: "revision-2-hash",
      proposedAt: null,
      approvedAt: null,
    };
    detail.currentRevision = {
      revision: draftRevision,
      elements: approved.elements.map((entry) => ({
        ...entry,
        version: {
          ...entry.version,
          revisionId: draftRevision.id,
          ...(entry.element.id === "requirement-1"
            ? {
                payload: {
                  kind: "requirement" as const,
                  statement:
                    "Every execution pins the full immutable scope for later review.",
                  priority: "must" as const,
                  risk: "high" as const,
                },
              }
            : {}),
        },
      })),
    };

    renderReader(detail, "requirements");

    expect(
      screen.getByRole("heading", { name: "Requirements" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Revision 2")).toBeInTheDocument();
    const requirement = screen.getByRole("article", {
      name: "R1 requirement",
    });
    expect(document.getElementById("R1")).toBe(requirement);
    expect(requirement).toHaveAttribute("tabindex", "-1");
    expect(within(requirement).getByText("Proof partial")).toBeInTheDocument();
    expect(within(requirement).getByText("Approved")).toBeInTheDocument();
    expect(
      within(requirement).getByRole("heading", {
        name: "Acceptance criteria",
      }),
    ).toBeInTheDocument();
    expect(within(requirement).getByText("R1.1")).toBeInTheDocument();
    expect(document.getElementById("R1.1")).toHaveAttribute("tabindex", "-1");
    expect(
      within(requirement).getByText(
        "The selected task and criterion are pinned.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Every execution pins scope."),
    ).not.toBeInTheDocument();
  });

  it("renders decision approach, rationale, and rejected alternatives", () => {
    renderReader(specElementReaderDetailFixture(), "decisions");

    const decision = screen.getByRole("article", {
      name: /D1 Pin the complete execution scope/i,
    });
    expect(
      within(decision).getByRole("heading", { name: "Chosen approach" }),
    ).toBeInTheDocument();
    expect(
      within(decision).getByText(
        "Persist the selected tasks and criteria with the execution.",
      ),
    ).toBeInTheDocument();
    expect(
      within(decision).getByRole("heading", { name: "Rationale" }),
    ).toBeInTheDocument();
    expect(
      within(decision).getByText(
        "A run must remain reproducible after authoring continues.",
      ),
    ).toBeInTheDocument();
    expect(
      within(decision).getByRole("heading", {
        name: "Rejected alternatives",
      }),
    ).toBeInTheDocument();
    expect(
      within(decision).getByText("Resolve scope when work starts"),
    ).toBeInTheDocument();
    expect(
      within(decision).getByText(
        "The source revision could change before launch.",
      ),
    ).toBeInTheDocument();
  });

  it("falls back to the approved revision and resolves task links to handles", () => {
    const detail = specElementReaderDetailFixture();
    detail.currentRevision = null;

    renderReader(detail, "tasks");

    const task = screen.getByRole("article", {
      name: /T2 Validate immutable scope/i,
    });
    expect(within(task).getByText("Running")).toBeInTheDocument();
    expect(within(task).getByText("Dependencies")).toBeInTheDocument();
    expect(within(task).getByText("T1")).toBeInTheDocument();
    expect(within(task).getByText("Requirement links")).toBeInTheDocument();
    expect(within(task).getByText("R1")).toBeInTheDocument();
    expect(
      within(task).getByText(
        "Prove that execution reads the snapshot captured at launch.",
      ),
    ).toBeInTheDocument();
  });

  it("explains when no current or approved document exists", () => {
    const detail = specElementReaderDetailFixture();
    detail.currentRevision = null;
    detail.currentApprovedRevision = null;

    renderReader(detail, "tasks");

    expect(screen.getByText("No revision available")).toBeInTheDocument();
    expect(
      screen.getByText(
        "A current or approved revision is required to read tasks.",
      ),
    ).toBeInTheDocument();
  });
});

describe("SpecElementReader draft removal", () => {
  it("offers no removal on an immutable revision", () => {
    const detail = specElementReaderDetailFixture();
    detail.currentRevision = null;

    renderReader(detail, "tasks");

    // Approved content is immutable, so the action must not render at all —
    // an enabled control that always refuses is worse than no control.
    expect(
      screen.queryByRole("button", { name: /remove/i }),
    ).not.toBeInTheDocument();
  });

  it("removes a draft element through the production draft-remove action and then names the reintroduction recovery", async () => {
    const user = userEvent.setup();
    api.json("POST", REMOVE_PATH, { ok: true });
    renderReader(draftDetailFixture(), "requirements");

    const requirement = screen.getByRole("article", { name: "R1 requirement" });
    await user.click(
      within(requirement).getByRole("button", { name: "Remove R1" }),
    );
    await user.click(
      within(requirement).getByRole("button", { name: "Confirm remove R1" }),
    );

    await waitFor(() =>
      expect(api.requestsTo("POST", REMOVE_PATH)).toHaveLength(1),
    );
    // The same compare-and-swap the CLI sends: the revision, the element, and
    // the version the removal takes out.
    expect(api.requestsTo("POST", REMOVE_PATH)[0]?.jsonBody).toEqual({
      revisionId: "revision-2",
      elementId: "requirement-1",
      baseElementVersion: 1,
    });

    // The element is gone from the document, so the undo has to be named
    // somewhere the reader can still see it.
    const notice = await screen.findByRole("status");
    expect(notice).toHaveTextContent("R1");
    expect(notice).toHaveTextContent("reintroduceHistorical");
  });

  it("surfaces the atomic dangling-reference refusal and names the dangling handle", async () => {
    const user = userEvent.setup();
    api.reply("POST", REMOVE_PATH, {
      status: 409,
      json: {
        code: "dangling_reference",
        unmetConditions: [
          "task-1.coveredCriterionElementIds[0] covers criterion criterion-1, which is not in this revision.",
        ],
        instruction:
          "Nothing was written. Rewrite or remove task-1 in the same write: drop the entry, repoint it at an element this revision carries, or remove the source alongside its target.",
        details: {
          references: [
            {
              code: "missing_target",
              sourceElementId: "task-1",
              field: "coveredCriterionElementIds",
              index: 0,
              targetId: "criterion-1",
              expectedKind: "criterion",
              actualKind: null,
              relation: "covers",
            },
          ],
        },
      },
    });
    renderReader(draftDetailFixture(), "requirements");

    const criterion = screen.getByRole("listitem", { name: "R1.1 criterion" });
    await user.click(
      within(criterion).getByRole("button", { name: "Remove R1.1" }),
    );
    await user.click(
      within(criterion).getByRole("button", { name: "Confirm remove R1.1" }),
    );

    const refusal = await screen.findByRole("alert");
    // Ids address storage; the reviewer reads handles, so both ends of the
    // dangling reference are named the way the document names them.
    expect(refusal).toHaveTextContent("T1 covers R1.1");
    expect(refusal).toHaveTextContent(/nothing was removed/i);
    // Still there: the refusal is whole-or-nothing.
    expect(
      screen.getByRole("listitem", { name: "R1.1 criterion" }),
    ).toBeInTheDocument();
  });

  it("passes a non-dangling refusal through in the server's own words", async () => {
    const user = userEvent.setup();
    api.reply("POST", REMOVE_PATH, {
      status: 409,
      json: {
        code: "stale_element",
        unmetConditions: ["R1 is at version 4; the removal named version 1."],
        instruction:
          "Nothing was written. Re-read the element and remove it at the version it is now at.",
      },
    });
    renderReader(draftDetailFixture(), "requirements");

    const requirement = screen.getByRole("article", { name: "R1 requirement" });
    await user.click(
      within(requirement).getByRole("button", { name: "Remove R1" }),
    );
    await user.click(
      within(requirement).getByRole("button", { name: "Confirm remove R1" }),
    );

    const refusal = await screen.findByRole("alert");
    // A stale-version refusal is not a reference problem: diagnosing it as one
    // would print a false cause and a remedy that cannot resolve it.
    expect(refusal).not.toHaveTextContent(/still referenced/i);
    expect(refusal).not.toHaveTextContent(/Rewrite the referring element/i);
    // The server authored the recovery that actually applies; it survives.
    expect(refusal).toHaveTextContent(
      "Re-read the element and remove it at the version it is now at.",
    );
  });
});
