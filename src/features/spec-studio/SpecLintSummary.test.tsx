// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import SpecLintSummary from "./SpecLintSummary";

describe("SpecLintSummary", () => {
  it("renders nothing for a completed zero-finding result", () => {
    const { container } = render(
      <SpecLintSummary
        projectName="command-center"
        slug="native-sdd"
        findings={[]}
        isPending={false}
        error={null}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("expands located findings and links to their owning element", async () => {
    render(
      <SpecLintSummary
        projectName="command-center"
        slug="native-sdd"
        findings={[
          {
            ruleId: "criterion/strategy",
            severity: "blocks_propose",
            elementHandle: "R1.1",
            message: "Add a validation strategy.",
          },
        ]}
        isPending={false}
        error={null}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: /1 lint finding/i }),
    );
    expect(screen.getByText("Add a validation strategy.")).toBeVisible();
    expect(screen.getByRole("link", { name: "R1.1" })).toHaveAttribute(
      "href",
      "/specs/command-center/native-sdd?el=R1.1",
    );
  });
});
