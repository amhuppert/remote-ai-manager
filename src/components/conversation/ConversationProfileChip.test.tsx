// @vitest-environment jsdom
/**
 * R6.5 display: a conversation with no snapshot reads as legacy/no-profile, and
 * a profiled one names its profile without ever rendering instruction text.
 *
 * Driven from the PUBLIC conversation the client actually receives — built by
 * running the production projector over a stored row — so the chip is proven
 * against the shape the read path produces, not a hand-written prop.
 */

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { toPublicConversationState } from "@/lib/conversations/schemas";
import {
  NO_OP_SNAPSHOT_FIXTURE,
  PROFILE_SECRET_SENTINEL,
  SNAPSHOT_FIXTURE,
  buildNoOpProfiledConversation,
  buildProfiledConversation,
  buildStoredConversation,
} from "@/lib/conversations/testing/profile-snapshot-fixtures";
import ConversationProfileChip from "./ConversationProfileChip";
import { deriveConversationProfileChipState } from "./conversation-profile-chip-state";

function renderChipFor(
  conversation: Parameters<typeof toPublicConversationState>[0],
) {
  const publicConversation = toPublicConversationState(conversation);
  return render(
    <ConversationProfileChip
      state={deriveConversationProfileChipState(
        publicConversation.redactedProfileSnapshot,
      )}
    />,
  );
}

describe("ConversationProfileChip", () => {
  it("reads as no-profile for a pre-feature conversation", () => {
    renderChipFor(buildStoredConversation({ id: "legacy-conv" }));

    const chip = screen.getByLabelText("Agent profile: No profile");
    expect(chip).toHaveTextContent("No profile");
    expect(chip).toHaveAttribute("data-state", "legacy");
    // Stated, not implied by an absent chip — a missing element would read as
    // "still loading" to a user and would satisfy no part of R6.5.
    expect(chip).toBeVisible();
  });

  // R3.3 identity-without-prompt-bytes: the no-op default delivers nothing to
  // the model, and it still reads as a named profile here. Identity comes from
  // the snapshot's fields, not from the instructions it no longer carries, so a
  // conversation under the default is never confused with a legacy one.
  it("names the no-op default as a profile, not as an absence", () => {
    renderChipFor(buildNoOpProfiledConversation({ id: "noop-conv" }));

    const chip = screen.getByLabelText(
      "Agent profile: Standard Agent (Built-in)",
    );
    expect(chip).toHaveTextContent("Standard Agent");
    expect(chip).toHaveAttribute("data-state", "profile");
    expect(chip).toHaveAttribute("data-tier", "builtin");
    expect(chip).toHaveAttribute(
      "title",
      `Agent profile builtin:standard-agent, revision ${NO_OP_SNAPSHOT_FIXTURE.revision}`,
    );
  });

  // R8.2, driven from a non-default project-tier profile: the header names the
  // profile AND the tier it came from. Both are visible text, not a tooltip —
  // `project:security-reviewer` and `global:security-reviewer` are different
  // profiles, so a name on its own does not say which one is running.
  it("names the profile and its source tier for a profiled conversation", () => {
    const { container } = renderChipFor(
      buildProfiledConversation({ id: "profiled-conv" }),
    );

    const chip = screen.getByLabelText(
      `Agent profile: ${SNAPSHOT_FIXTURE.name} (Project)`,
    );
    expect(chip).toHaveTextContent(SNAPSHOT_FIXTURE.name);
    expect(chip).toHaveTextContent("Project");
    expect(chip).toHaveAttribute("data-state", "profile");
    expect(chip).toHaveAttribute("data-tier", "project");
    expect(chip).toHaveAttribute(
      "title",
      `Agent profile project:security-reviewer, revision ${SNAPSHOT_FIXTURE.revision}`,
    );
    // Nothing rendered — label, text, or attribute — carries instruction text.
    expect(container.innerHTML).not.toContain(PROFILE_SECRET_SENTINEL);
  });
});
