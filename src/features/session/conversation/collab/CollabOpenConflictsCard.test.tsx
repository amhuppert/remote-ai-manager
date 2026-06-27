// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import CollabOpenConflictsCard from "@/features/session/conversation/collab/CollabOpenConflictsCard";

const DISAGREEMENTS = [
  {
    id: "d-1",
    category: "objective" as const,
    severity: "blocking" as const,
    claim: "v1 vs v2 contract.",
    reason: "v2 breaks consumers",
  },
  {
    id: "d-2",
    category: "implementation" as const,
    severity: "major" as const,
    claim: "cache TTL strategy",
    reason: "warm-up vs raise TTL",
  },
];

const QUESTIONS = [
  {
    id: "q-1",
    question: "Ship v1 or v2?",
    related_disagreement_ids: ["d-1"],
  },
  {
    id: "q-2",
    question: "Allow brief cache miss spike?",
    related_disagreement_ids: ["d-2"],
  },
];

describe("CollabOpenConflictsCard (awaiting mode)", () => {
  it("lists every disagreement with its severity/category chip", () => {
    render(
      <CollabOpenConflictsCard
        mode="awaiting"
        disagreements={DISAGREEMENTS}
        questions={QUESTIONS}
        drafts={{}}
        onDraftChange={vi.fn()}
        onSubmit={vi.fn()}
        isSubmitting={false}
      />,
    );

    expect(screen.getByText(/v1 vs v2 contract/)).toBeInTheDocument();
    expect(screen.getByText(/cache TTL strategy/)).toBeInTheDocument();

    const chips = document.querySelectorAll("[data-severity]");
    expect(chips).toHaveLength(2);
  });

  it("renders a textarea per question and forwards changes via onDraftChange", async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    render(
      <CollabOpenConflictsCard
        mode="awaiting"
        disagreements={DISAGREEMENTS}
        questions={QUESTIONS}
        drafts={{}}
        onDraftChange={onDraftChange}
        onSubmit={vi.fn()}
        isSubmitting={false}
      />,
    );

    const ta = screen.getByLabelText(/Answer for q-1/i);
    await user.type(ta, "v1");
    expect(onDraftChange).toHaveBeenCalled();
    const lastCall = onDraftChange.mock.calls.at(-1);
    expect(lastCall?.[0]).toBe("q-1");
  });

  it("disables submit until at least one draft has a non-empty value", () => {
    const { rerender } = render(
      <CollabOpenConflictsCard
        mode="awaiting"
        disagreements={DISAGREEMENTS}
        questions={QUESTIONS}
        drafts={{ "q-1": "   " }}
        onDraftChange={vi.fn()}
        onSubmit={vi.fn()}
        isSubmitting={false}
      />,
    );

    const submit = screen.getByRole("button", { name: /Send answers/i });
    expect(submit).toBeDisabled();

    rerender(
      <CollabOpenConflictsCard
        mode="awaiting"
        disagreements={DISAGREEMENTS}
        questions={QUESTIONS}
        drafts={{ "q-1": "Ship v1" }}
        onDraftChange={vi.fn()}
        onSubmit={vi.fn()}
        isSubmitting={false}
      />,
    );

    expect(screen.getByRole("button", { name: /Send answers/i })).toBeEnabled();
  });

  it("disables form controls and shows submitting label when isSubmitting is true", () => {
    render(
      <CollabOpenConflictsCard
        mode="awaiting"
        disagreements={DISAGREEMENTS}
        questions={QUESTIONS}
        drafts={{ "q-1": "Ship v1" }}
        onDraftChange={vi.fn()}
        onSubmit={vi.fn()}
        isSubmitting
      />,
    );

    expect(screen.getByLabelText(/Answer for q-1/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /Submitting…/i })).toBeDisabled();
  });
});

describe("CollabOpenConflictsCard (answered mode)", () => {
  it("renders submitted answers as read-only text without a form or submit button", () => {
    render(
      <CollabOpenConflictsCard
        mode="answered"
        disagreements={DISAGREEMENTS}
        questions={QUESTIONS}
        submittedAnswers={{ "q-1": "Ship v1", "q-2": "Yes, allow brief spike" }}
      />,
    );

    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Send answers/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Submitting…/i }),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Ship v1")).toBeInTheDocument();
    expect(screen.getByText("Yes, allow brief spike")).toBeInTheDocument();
  });

  it("shows a placeholder when a question received no answer", () => {
    render(
      <CollabOpenConflictsCard
        mode="answered"
        disagreements={DISAGREEMENTS}
        questions={QUESTIONS}
        submittedAnswers={{ "q-1": "Ship v1" }}
      />,
    );

    expect(screen.getByText("Ship v1")).toBeInTheDocument();
    expect(screen.getByText(/No answer/i)).toBeInTheDocument();
  });

  it("still lists disagreements in the answered view", () => {
    render(
      <CollabOpenConflictsCard
        mode="answered"
        disagreements={DISAGREEMENTS}
        questions={QUESTIONS}
        submittedAnswers={{}}
      />,
    );

    expect(screen.getByText(/v1 vs v2 contract/)).toBeInTheDocument();
    expect(screen.getByText(/cache TTL strategy/)).toBeInTheDocument();
  });
});
