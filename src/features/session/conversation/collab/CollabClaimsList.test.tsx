// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CollabClaimsList from "@/features/session/conversation/collab/CollabClaimsList";

describe("CollabClaimsList", () => {
  it("renders nothing when all sections are empty", () => {
    const { container } = render(<CollabClaimsList />);
    expect(container.firstChild).toBeNull();
  });

  it("only renders sections that have entries", () => {
    render(
      <CollabClaimsList
        agree={[{ id: "a-1", claim: "yes" }]}
        disagree={[]}
        reviseSelf={[]}
      />,
    );
    expect(screen.getByText(/AGREE \(1\)/)).toBeInTheDocument();
    expect(screen.queryByText(/DISAGREE/)).toBeNull();
    expect(screen.queryByText(/REVISE SELF/)).toBeNull();
  });

  it("invokes onRefClick with the full CollaborationReference object when a ref chip is clicked", async () => {
    const user = userEvent.setup();
    const onRefClick = vi.fn();
    render(
      <CollabClaimsList
        agree={[
          {
            id: "a-1",
            claim: "schema first",
            ref: { artifact: "agent_one/r0/draft.md", locator: "L42" },
          },
        ]}
        onRefClick={onRefClick}
      />,
    );

    const refButton = screen.getByRole("button", {
      name: /agent_one\/r0\/draft\.md#L42/,
    });
    await user.click(refButton);
    expect(onRefClick).toHaveBeenCalledWith({
      artifact: "agent_one/r0/draft.md",
      locator: "L42",
    });
  });
});
