import { describe, expect, it } from "vitest";

import { formatNotepadFeedbackPrompt } from "./format-feedback";
import type { NotepadFeedbackPayload } from "@/lib/conversations/message-content-schemas";

const payload: NotepadFeedbackPayload = {
  notepadId: "np-1",
  notepadName: "Release plan",
  notepadRefXml:
    '<notepad-ref notepad-id="np-1" name="Release plan" scope="global" read-command="cctl notepad get np-1" />',
  items: [
    {
      commentId: "c-1",
      location: "§ Rollout · L12",
      quote: "ship on Friday",
      body: "Friday deploys are frozen — pick another day.",
    },
    {
      commentId: "c-2",
      location: "L3",
      quote: "no rollback plan",
      body: "Write one.",
    },
  ],
};

describe("formatNotepadFeedbackPrompt", () => {
  it("carries the notepad reference so the agent can read the notepad", () => {
    expect(formatNotepadFeedbackPrompt(payload)).toContain(
      payload.notepadRefXml,
    );
  });

  it("carries every comment's location, quoted context, and body", () => {
    const text = formatNotepadFeedbackPrompt(payload);
    for (const item of payload.items) {
      expect(text).toContain(item.location);
      expect(text).toContain(item.quote);
      expect(text).toContain(item.body);
    }
  });

  it("names the notepad the comments belong to", () => {
    expect(formatNotepadFeedbackPrompt(payload)).toContain("Release plan");
  });

  it("omits comment ids — they are the durable record's identity, not prose", () => {
    const text = formatNotepadFeedbackPrompt(payload);
    expect(text).not.toContain("c-1");
    expect(text).not.toContain("c-2");
  });
});
