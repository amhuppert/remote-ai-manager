// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { renderWithQuery } from "@/test/component-mocks";
import { installFetchFixture } from "@/test/fetch-fixture";
import SpecDeliveryScope from "./SpecDeliveryScope";
import { deliveryDashboardFixture } from "./SpecDeliveryScope.fixtures";

function renderScope(fixture = deliveryDashboardFixture()) {
  return renderWithQuery(
    <SpecDeliveryScope {...fixture} projectName="command-center" />,
  );
}

describe("Delivery scope inspection", () => {
  it("bounds the list, searches full content, and opens decision rationale with a Design link", async () => {
    renderScope();
    expect(screen.getByRole("progressbar")).toHaveAttribute("value", "4");
    expect(screen.getByText("1–8 of 12")).toBeVisible();
    expect(screen.queryByText(/Capture discoveries for the next/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("9–12 of 12")).toBeVisible();
    await userEvent.click(screen.getByRole("tab", { name: /Spec changes/ }));
    await userEvent.type(
      screen.getByRole("textbox", { name: "Search scope" }),
      "reproducible",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /Pin the complete execution scope/ }),
    );
    expect(
      screen.getByText(
        "A run must remain reproducible after authoring continues.",
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Open current Design" }),
    ).toHaveAttribute("href", "/specs/command-center/native-sdd?el=D1");
  });

  it("reads the compared approved revision even when a newer draft changes the same criterion", async () => {
    const fixture = deliveryDashboardFixture();
    const approved = fixture.detail.currentApprovedRevision;
    if (!approved) throw new Error("Expected approved fixture");
    fixture.detail.currentRevision = {
      ...approved,
      revision: {
        ...approved.revision,
        id: "draft-after-approval",
        state: "draft",
        number: 9,
      },
      elements: approved.elements.map((entry) =>
        entry.element.id === "criterion-1"
          ? {
              ...entry,
              version: {
                ...entry.version,
                payload: {
                  kind: "criterion",
                  text: "Unapproved draft content",
                  validationStrategy: { kinds: ["test_run"] },
                },
              },
            }
          : entry,
      ),
    };
    renderScope(fixture);
    expect(screen.queryByText("Unapproved draft content")).toBeNull();
    await userEvent.click(
      screen.getByRole("button", {
        name: /Persist the complete execution scope at launch/,
      }),
    );
    expect(
      screen.getByRole("link", { name: "Open current Requirements" }),
    ).toHaveAttribute("href", "/specs/command-center/native-sdd?el=R1.1");
    expect(screen.getByText(/Content from revision/)).toHaveTextContent(
      `Content from revision ${approved.revision.number}`,
    );
  });

  it("shows removed content from its baseline and links revision history", async () => {
    const fixture = deliveryDashboardFixture();
    const snapshot = fixture.detail.currentApprovedRevision;
    if (!snapshot) throw new Error("Expected snapshot");
    fixture.detail.baseRevision = {
      ...snapshot,
      revision: { ...snapshot.revision, id: "delivered-revision", number: 1 },
      elements: snapshot.elements.map((entry) =>
        entry.version.payload.kind === "decision"
          ? {
              ...entry,
              version: {
                ...entry.version,
                payload: {
                  ...entry.version.payload,
                  title: "Historical decision",
                  reason: "Historical rationale",
                },
              },
            }
          : entry,
      ),
    };
    fixture.projection.elements = fixture.projection.elements.map((row) =>
      row.kind === "decision"
        ? { ...row, class: "removed", currentHash: null }
        : row,
    );
    renderScope(fixture);
    await userEvent.click(screen.getByRole("tab", { name: /Spec changes/ }));
    await userEvent.click(
      screen.getByRole("button", { name: /Historical decision/ }),
    );
    expect(screen.getByText("Historical rationale")).toBeVisible();
    expect(
      screen.getByRole("link", { name: "View revision history" }),
    ).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?view=history&revision=delivered-revision",
    );
  });

  it("filters by the server classification and shows an explicit search empty state", async () => {
    renderScope();
    await userEvent.click(
      screen.getByRole("combobox", { name: "Scope status" }),
    );
    await userEvent.click(
      screen.getByRole("option", { name: "Needs revalidation · 1" }),
    );
    expect(screen.getByText("1–1 of 1")).toBeVisible();
    expect(screen.getByText(/Revalidate affected criteria/)).toBeVisible();
    await userEvent.type(
      screen.getByRole("textbox", { name: "Search scope" }),
      "does not exist",
    );
    expect(
      screen.getByText(
        "No matching items. Adjust the search or status filter.",
      ),
    ).toBeVisible();
  });

  it("loads missing historical content only after expansion and pins the request to that revision", async () => {
    const fixture = deliveryDashboardFixture();
    const snapshot = fixture.detail.currentApprovedRevision;
    const entry = snapshot?.elements.find(
      (element) => element.element.id === "criterion-1",
    );
    if (!snapshot || !entry) throw new Error("Expected criterion fixture");
    const api = installFetchFixture();
    try {
      api.json("GET", "/api/specs/command-center/native-sdd/elements/R1.1", {
        specId: fixture.detail.spec.id,
        slug: fixture.detail.spec.slug,
        revision: snapshot.revision,
        handle: "R1.1",
        element: { element: entry.element, version: entry.version },
        approvals: [],
        evidenceState: [],
        referenceState: null,
      });
      fixture.detail.currentApprovedRevision = null;
      fixture.detail.currentRevision = null;
      fixture.detail.executionRevisionSnapshots = [];
      fixture.detail.baseRevision = null;
      renderScope(fixture);
      expect(api.requestsTo("GET", /elements/)).toHaveLength(0);
      const panel = screen.getByRole("tabpanel");
      await userEvent.click(
        within(panel).getByRole("button", { name: /R1.1 · criterion/ }),
      );
      expect(
        await screen.findByText(
          "Persist the complete execution scope at launch so every task reads the approved contract.",
        ),
      ).toBeVisible();
      expect(api.requestsTo("GET", /elements/)).toHaveLength(1);
      expect(
        api.requestsTo("GET", /elements/)[0]?.searchParams.get("revisionId"),
      ).toBe(snapshot.revision.id);
    } finally {
      api.restore();
    }
  });
});
