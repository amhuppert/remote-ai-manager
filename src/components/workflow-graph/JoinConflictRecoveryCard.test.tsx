// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, it, expect, vi } from "vitest";
import JoinConflictRecoveryCard from "./JoinConflictRecoveryCard";

const ANALYSIS = [
  {
    file: "src/foo.ts",
    description: "Both sides changed the loader signature.",
    resolution: "Keep both parameters and merge the option objects.",
    rationale: "The changes are logically independent.",
  },
];

describe("JoinConflictRecoveryCard", () => {
  it("shows the resolver's per-file analysis when present", () => {
    render(
      <JoinConflictRecoveryCard
        conflictFiles={["src/foo.ts", "src/bar.ts"]}
        analysis={ANALYSIS}
        onRetry={() => {}}
        isRetrying={false}
        disabled={false}
      />,
    );

    expect(
      screen.getByText("Both sides changed the loader signature."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Keep both parameters and merge the option objects./),
    ).toBeInTheDocument();
    // Files without analysis still get a row (and a guidance input).
    expect(screen.getByText("src/bar.ts")).toBeInTheDocument();
  });

  it("submits per-file guidance only for files with feedback", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <JoinConflictRecoveryCard
        conflictFiles={["src/foo.ts", "src/bar.ts"]}
        analysis={null}
        onRetry={onRetry}
        isRetrying={false}
        disabled={false}
      />,
    );

    await user.type(
      screen.getByLabelText("Guidance for src/foo.ts"),
      "keep both hunks",
    );
    await user.click(screen.getByRole("button", { name: /retry merge/i }));

    expect(onRetry).toHaveBeenCalledWith([
      { file: "src/foo.ts", decision: "rejected", feedback: "keep both hunks" },
    ]);
  });

  it("retries with no guidance when nothing was entered", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <JoinConflictRecoveryCard
        conflictFiles={["src/foo.ts"]}
        analysis={null}
        onRetry={onRetry}
        isRetrying={false}
        disabled={false}
      />,
    );

    await user.click(screen.getByRole("button", { name: /retry merge/i }));
    expect(onRetry).toHaveBeenCalledWith([]);
  });

  it("disables the retry button while a retry is pending", () => {
    render(
      <JoinConflictRecoveryCard
        conflictFiles={["src/foo.ts"]}
        analysis={null}
        onRetry={() => {}}
        isRetrying={true}
        disabled={true}
      />,
    );

    expect(screen.getByRole("button", { name: /retrying/i })).toBeDisabled();
  });
});
