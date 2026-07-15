// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import {
  coerceMentionAttrs,
  ConversationMentionChipBody,
} from "./ConversationMentionChip";

afterEach(cleanup);

const NODE_ATTRS = {
  projectName: "proj",
  projectPath: "/proj",
  sessionName: "sess",
  worktreePath: "/wt",
  conversationId: "conv-1",
  conversationName: "My conversation",
  backendRef: "ref-1",
  transcriptPath: "",
  debugLogPath: "",
  status: "running",
  lastActivityAt: "2026-07-12T00:00:00Z",
  compactArtifactId: "",
  compactStatus: "none",
  compactCoveredSeq: "",
  compactCreatedAt: "",
};

describe("coerceMentionAttrs backend parsing", () => {
  it("keeps a canonical backend id", () => {
    expect(
      coerceMentionAttrs({ ...NODE_ATTRS, backend: "codex" }).backend,
    ).toBe("codex");
    expect(
      coerceMentionAttrs({ ...NODE_ATTRS, backend: "claude" }).backend,
    ).toBe("claude");
  });

  it("does NOT coerce an unknown backend id to claude — it becomes null", () => {
    expect(
      coerceMentionAttrs({ ...NODE_ATTRS, backend: "mystery" }).backend,
    ).toBeNull();
    expect(coerceMentionAttrs({ ...NODE_ATTRS }).backend).toBeNull();
    expect(coerceMentionAttrs(null).backend).toBeNull();
  });
});

describe("ConversationMentionChipBody", () => {
  it("renders a known backend identity on the chip", () => {
    render(
      <ConversationMentionChipBody
        attrs={coerceMentionAttrs({ ...NODE_ATTRS, backend: "codex" })}
        selected={false}
        onRemove={vi.fn()}
      />,
    );
    const chip = screen.getByTitle("proj · sess");
    expect(chip.getAttribute("data-backend")).toBe("codex");
    expect(chip.hasAttribute("data-backend-unknown")).toBe(false);
  });

  it("renders an explicit error state for an unknown backend id instead of claiming claude", () => {
    render(
      <ConversationMentionChipBody
        attrs={coerceMentionAttrs({ ...NODE_ATTRS, backend: "mystery" })}
        selected={false}
        onRemove={vi.fn()}
      />,
    );
    const chip = screen.getByTitle(/unknown agent backend/i);
    expect(chip.getAttribute("data-backend")).toBeNull();
    expect(chip.getAttribute("data-backend-unknown")).toBe("true");
  });
});
