// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import CollabConfigRow from "@/components/session/CollabConfigRow";

describe("CollabConfigRow", () => {
  it("renders autonomous threshold labels as the exact lowercase values", () => {
    render(
      <CollabConfigRow
        originatingAgent="claude"
        config={{
          secondAgent: "codex",
          negotiationRounds: 3,
          autonomousResolutionThreshold: "major",
        }}
        onChange={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );

    for (const label of ["none", "minor", "major", "blocking"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    for (const label of ["None", "Minor", "Major", "Blocking"]) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });
});
