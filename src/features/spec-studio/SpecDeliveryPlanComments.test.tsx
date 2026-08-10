// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DeliveryPlanReviewView } from "@/lib/specs/delivery-plan-review";

import SpecDeliveryPlanComments from "./SpecDeliveryPlanComments";
import { reviewView } from "./delivery-plan-review.fixtures";

// The anchor picker is Radix-backed, and Radix moves real focus / captures the
// pointer; jsdom implements neither (same stubs as `RadioGroup.test.tsx`).
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

function renderComments(review: DeliveryPlanReviewView = reviewView()): {
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  vi.stubGlobal(
    "fetch",
    async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body:
          typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      const next: DeliveryPlanReviewView = {
        ...review,
        comments: [
          ...review.comments,
          {
            id: "comment-new",
            contextId: "dpa-closeout",
            body: "The closeout contract needs a named survivor.",
            author: { kind: "human" },
            createdAt: "2026-08-08T10:00:00.000Z",
            orphaned: false,
          },
        ],
      };
      return Response.json(next);
    },
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <SpecDeliveryPlanComments projectName="command-center" review={review} />
    </QueryClientProvider>,
  );
  return { calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SpecDeliveryPlanComments", () => {
  it("shows each comment against the context it anchors to", () => {
    renderComments();

    const live = document.querySelector<HTMLElement>(
      '[data-comment-id="comment-live"]',
    );
    expect(live).not.toBeNull();
    if (live === null) return;
    expect(within(live).getByText("dpa-document")).toBeVisible();
    expect(
      within(live).getByText(
        "Split the lint criterion out; two proofs, two contexts.",
      ),
    ).toBeVisible();
  });

  /**
   * The orphan is the case the anchor exists for: the note stays, and the
   * surface says plainly that the context it discussed is gone.
   */
  it("marks a comment whose context the plan no longer declares", () => {
    renderComments();

    const orphan = document.querySelector<HTMLElement>(
      '[data-comment-id="comment-orphan"]',
    );
    expect(orphan?.dataset.orphaned).toBe("true");
    expect(
      within(orphan as HTMLElement).getByText(
        /this plan no longer declares that context/,
      ),
    ).toBeVisible();
  });

  it("posts a new comment to the production action route with its anchor", async () => {
    const user = userEvent.setup();
    const { calls } = renderComments();

    await user.click(
      within(
        screen.getByRole("radiogroup", { name: "Anchor context" }),
      ).getByRole("radio", { name: "dpa-closeout" }),
    );
    await user.type(
      screen.getByLabelText("Comment"),
      "The closeout contract needs a named survivor.",
    );
    await user.click(screen.getByRole("button", { name: "Comment" }));

    await waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]).toEqual({
      url: "/api/specs/command-center/native-sdd/actions/plan-comment",
      method: "POST",
      body: {
        contextId: "dpa-closeout",
        body: "The closeout contract needs a named survivor.",
      },
    });
  });

  /**
   * The anchor picker is a real radio group rather than a row of buttons, so a
   * keyboard reviewer arrows between context ids instead of tabbing past every
   * one of them. Only the focus move is asserted here: selection-follows-focus
   * is Radix behaviour jsdom orders differently, verified in the live keyboard
   * pass (see `RadioGroup.test.tsx`).
   */
  it("arrows between anchors on one tab stop", async () => {
    const user = userEvent.setup();
    renderComments();

    const group = screen.getByRole("radiogroup", { name: "Anchor context" });
    const first = within(group).getByRole("radio", { name: "dpa-document" });
    const second = within(group).getByRole("radio", { name: "dpa-closeout" });
    // Roving tabindex: the unselected anchor is not its own tab stop.
    expect(second.tabIndex).toBe(-1);

    first.focus();
    await user.keyboard("{ArrowDown}");

    expect(document.activeElement).toBe(second);
  });

  it("refuses to submit an empty comment", () => {
    renderComments();

    expect(screen.getByRole("button", { name: "Comment" })).toBeDisabled();
  });

  it("says plainly when nothing has been commented on", () => {
    renderComments(reviewView({ comments: [] }));

    expect(
      screen.getByText("No one has commented on this attempt."),
    ).toBeVisible();
  });
});
