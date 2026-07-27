import { describe, expect, it } from "vitest";
import type { SerializedPromptDoc } from "@/lib/prompt-editor";
import {
  PROJECT_FIRST_RUN_DRAFT_KEY,
  deleteProjectDraft,
  hasProjectDraftContent,
  projectDraftKey,
  setProjectDraft,
  type ProjectDraftMap,
} from "./project-draft-map";

const textDraft: SerializedPromptDoc = {
  prompt: "Keep this thought",
  images: [],
};

describe("project draft map", () => {
  it("scopes drafts to each conversation and to the first-run composer", () => {
    expect(projectDraftKey("conversation-a")).toBe("conversation-a");
    expect(projectDraftKey(null)).toBe(PROJECT_FIRST_RUN_DRAFT_KEY);
  });

  it("treats text and image payloads as draft content", () => {
    expect(hasProjectDraftContent({ prompt: "  ", images: [] })).toBe(false);
    expect(hasProjectDraftContent(textDraft)).toBe(true);
    expect(
      hasProjectDraftContent({
        prompt: "",
        images: [
          {
            attachmentId: "img-1",
            mediaType: "image/png",
            base64Data: "payload",
          },
        ],
      }),
    ).toBe(true);
  });

  it("updates one conversation without changing another", () => {
    const original: ProjectDraftMap = new Map([["conversation-a", textDraft]]);
    const next = setProjectDraft(original, "conversation-b", {
      prompt: "Second draft",
      images: [],
    });

    expect(next).not.toBe(original);
    expect(next.get("conversation-a")).toEqual(textDraft);
    expect(next.get("conversation-b")?.prompt).toBe("Second draft");
  });

  it("removes only the requested conversation draft", () => {
    const original: ProjectDraftMap = new Map([
      ["conversation-a", textDraft],
      ["conversation-b", { prompt: "Second", images: [] }],
    ]);

    expect(deleteProjectDraft(original, "conversation-a")).toEqual(
      new Map([["conversation-b", { prompt: "Second", images: [] }]]),
    );
  });
});
