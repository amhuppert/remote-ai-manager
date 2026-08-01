// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { UpstreamInputsList } from "./UpstreamInputsList";
import type { GraphWorkflowUpstreamInput } from "@/lib/workflow-graph/context-outputs";

const TRIAGE: GraphWorkflowUpstreamInput = {
  contextId: "context-triage",
  title: "Triage the failure report",
  declared: true,
  schemaFields: [
    { name: "verdict", type: "string", required: true, description: null },
    { name: "blockers", type: "array", required: true, description: null },
    { name: "confidence", type: "number", required: false, description: null },
  ],
  output: null,
};

const REVIEW: GraphWorkflowUpstreamInput = {
  contextId: "context-review",
  title: "Review the spec delta",
  declared: true,
  schemaFields: [
    { name: "approved", type: "boolean", required: true, description: null },
  ],
  output: { approved: true },
};

const FREE_FORM: GraphWorkflowUpstreamInput = {
  contextId: "context-notes",
  title: "Collect the notes",
  declared: false,
  schemaFields: null,
  output: null,
};

// A valid declaration the field walker cannot summarize: it constrains the
// payload without naming top-level properties (a bare object, or a root
// `oneOf`). It is declared, and the list must not present it as free-form.
const BARE_OBJECT: GraphWorkflowUpstreamInput = {
  contextId: "context-audit",
  title: "Audit the run",
  declared: true,
  schemaFields: null,
  output: { any: "shape" },
};

function rows(): HTMLElement[] {
  return screen.getAllByTestId("upstream-input-row");
}

function fieldNames(row: HTMLElement): string[] {
  return within(row)
    .queryAllByTestId("upstream-input-field")
    .map((chip) => chip.textContent ?? "");
}

describe("UpstreamInputsList", () => {
  it("renders nothing when the context has no upstream contexts", () => {
    const { container } = render(<UpstreamInputsList inputs={[]} />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId("upstream-inputs")).toBeNull();
  });

  it("lists every declared upstream with its field-name chips", () => {
    render(<UpstreamInputsList inputs={[TRIAGE, REVIEW]} />);

    const [triage, review] = rows();
    expect(triage).toBeDefined();
    expect(review).toBeDefined();
    expect(within(triage!).getByText("Triage the failure report")).toBeTruthy();
    expect(fieldNames(triage!)).toEqual(["verdict", "blockers", "confidence"]);
    expect(fieldNames(review!)).toEqual(["approved"]);
    expect(screen.queryByTestId("upstream-input-prose")).toBeNull();
    expect(screen.getByTestId("upstream-inputs-count").textContent).toContain(
      "2 of 2",
    );
  });

  it("keeps a schema-less upstream listed as prose-only rather than hiding it", () => {
    render(<UpstreamInputsList inputs={[TRIAGE, FREE_FORM]} />);

    const [, freeForm] = rows();
    expect(freeForm).toBeDefined();
    expect(within(freeForm!).getByText("Collect the notes")).toBeTruthy();
    expect(fieldNames(freeForm!)).toEqual([]);
    expect(
      within(freeForm!).getByTestId("upstream-input-prose").textContent,
    ).toContain("No schema");
    expect(freeForm!.dataset.declared).toBe("false");
    expect(screen.getByTestId("upstream-inputs-count").textContent).toContain(
      "1 of 2",
    );
  });

  it("still lists upstreams when none of them declares a schema", () => {
    render(
      <UpstreamInputsList
        inputs={[
          FREE_FORM,
          { ...FREE_FORM, contextId: "context-scan", title: "Scan the repo" },
        ]}
      />,
    );

    expect(rows()).toHaveLength(2);
    expect(screen.getAllByTestId("upstream-input-prose")).toHaveLength(2);
    expect(screen.getByTestId("upstream-inputs-count").textContent).toContain(
      "0 of 2",
    );
    // The note must not promise an injection that will not happen.
    expect(screen.getByTestId("upstream-inputs-note").textContent).toContain(
      "No upstream context declares an output schema",
    );
  });

  it("marks a banked upstream output apart from one still owed", () => {
    render(<UpstreamInputsList inputs={[TRIAGE, REVIEW]} />);

    const [triage, review] = rows();
    expect(triage!.dataset.captured).toBe("false");
    expect(review!.dataset.captured).toBe("true");
    // The glyph tone is not the only route to the distinction.
    expect(
      within(review!).getByLabelText(/captured/i, { selector: "[role=img]" }),
    ).toBeTruthy();
    expect(
      within(triage!).getByLabelText(/not yet captured/i, {
        selector: "[role=img]",
      }),
    ).toBeTruthy();
  });

  it("counts a declared schema with no named fields as declared, not as prose-only", () => {
    render(<UpstreamInputsList inputs={[BARE_OBJECT, FREE_FORM]} />);

    const [bare, freeForm] = rows();
    expect(bare!.dataset.declared).toBe("true");
    expect(freeForm!.dataset.declared).toBe("false");
    // Its banked payload IS this context's structured input, so the row must
    // read as captured rather than as a free-form upstream.
    expect(bare!.dataset.captured).toBe("true");
    expect(fieldNames(bare!)).toEqual([]);
    expect(
      within(bare!).getByTestId("upstream-input-prose").textContent,
    ).toContain("no named top-level fields");
    expect(screen.getByTestId("upstream-inputs-count").textContent).toContain(
      "1 of 2",
    );
  });

  it("renders the rows it is given, in the order it is given them", () => {
    render(<UpstreamInputsList inputs={[REVIEW, FREE_FORM, TRIAGE]} />);

    expect(rows().map((row) => row.dataset.contextId)).toEqual([
      "context-review",
      "context-notes",
      "context-triage",
    ]);
  });
});
