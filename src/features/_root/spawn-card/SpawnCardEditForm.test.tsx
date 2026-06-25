// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import SpawnCardEditForm from "./SpawnCardEditForm";
import type { EditableSession } from "./useSpawnCard";

// Radix focuses items / captures the pointer on open; jsdom implements neither.
Element.prototype.scrollIntoView = () => {};
Element.prototype.hasPointerCapture = () => false;
Element.prototype.setPointerCapture = () => {};
Element.prototype.releasePointerCapture = () => {};

afterEach(cleanup);

const session: EditableSession = {
  name: "alpha",
  branch: "feat/alpha",
  target: "main",
  agent: "claude",
  mode: "fast",
  initialPrompt: "",
};

describe("SpawnCardEditForm", () => {
  it("renders the agent + mode pickers on the CC Select primitive", () => {
    render(
      <SpawnCardEditForm index={0} session={session} onChange={() => {}} />,
    );
    const agent = screen.getByRole("combobox", { name: "Session 1 agent" });
    const mode = screen.getByRole("combobox", { name: "Session 1 mode" });
    // The CC Select trigger carries the surface recipe; a native <select> would
    // carry the legacy `prompt-input` class instead.
    expect(agent.className).toContain("bg-bg-surface");
    expect(agent.className).toContain("border-border-default");
    expect(mode.className).toContain("bg-bg-surface");
    // The current value is shown in the trigger.
    expect(agent.textContent).toContain("claude");
    expect(mode.textContent).toContain("fast");
  });
});
