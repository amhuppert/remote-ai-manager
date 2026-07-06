import { describe, it, expect } from "vitest";
import {
  findConversationRefs,
  parseConversationRefAttrs,
} from "./conversation-ref-parser";
import { conversationRefAttrsSchema } from "./schemas";

const SAMPLE_REF =
  '<conversation-ref project-name="proj" project-path="/p" session-name="sess" worktree-path="/w" conversation-id="abc" conversation-name="Hello" backend="claude" backend-ref="sid-1" transcript-path="/t.jsonl" debug-log-path="" status="awaiting" last-activity-at="2026-01-01T00:00:00Z" />';

const COMPACT_REF = SAMPLE_REF.replace(
  " />",
  ' compact-artifact-id="art-1" compact-status="fresh" compact-covered-seq="0..421" compact-created-at="2026-07-01T00:00:00Z" />',
);

describe("findConversationRefs", () => {
  it("finds a single ref in plain text", () => {
    const text = `Before ${SAMPLE_REF} after`;
    const refs = findConversationRefs(text);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.raw).toBe(SAMPLE_REF);
    expect(refs[0]?.attrs["conversation-id"]).toBe("abc");
    expect(refs[0]?.attrs["conversation-name"]).toBe("Hello");
  });

  it("returns multiple refs in document order", () => {
    const text = `${SAMPLE_REF} middle ${SAMPLE_REF}`;
    const refs = findConversationRefs(text);
    expect(refs).toHaveLength(2);
    expect(refs[0]!.start).toBeLessThan(refs[1]!.start);
  });

  it("skips refs inside triple-backtick fenced code blocks", () => {
    const text = `Before\n\`\`\`\n${SAMPLE_REF}\n\`\`\`\nAfter`;
    expect(findConversationRefs(text)).toHaveLength(0);
  });

  it("skips refs inside triple-tilde fenced code blocks", () => {
    const text = `Before\n~~~\n${SAMPLE_REF}\n~~~\nAfter`;
    expect(findConversationRefs(text)).toHaveLength(0);
  });

  it("finds refs outside a fenced block while ignoring those inside", () => {
    const text = `${SAMPLE_REF}\n\`\`\`\n${SAMPLE_REF}\n\`\`\`\n${SAMPLE_REF}`;
    const refs = findConversationRefs(text);
    expect(refs).toHaveLength(2);
  });

  it("matches refs adjacent without whitespace between them", () => {
    const text = `${SAMPLE_REF}${SAMPLE_REF}`;
    expect(findConversationRefs(text)).toHaveLength(2);
  });

  it("does not match a malformed tag missing attributes", () => {
    const text = "<conversation-ref/>";
    expect(findConversationRefs(text)).toHaveLength(0);
  });

  it("provides start and end character offsets that delimit the tag exactly", () => {
    const prefix = "Hello ";
    const text = `${prefix}${SAMPLE_REF}!`;
    const [ref] = findConversationRefs(text);
    expect(text.slice(ref!.start, ref!.end)).toBe(SAMPLE_REF);
  });
});

describe("parseConversationRefAttrs", () => {
  it("returns the full attribute map for a well-formed ref", () => {
    const attrs = parseConversationRefAttrs(SAMPLE_REF);
    expect(attrs["project-name"]).toBe("proj");
    expect(attrs["backend"]).toBe("claude");
    expect(attrs["debug-log-path"]).toBe("");
  });

  it("decodes XML entities in attribute values", () => {
    const raw = `<conversation-ref project-name="P&amp;Q" project-path="/p" session-name="s" worktree-path="/w" conversation-id="abc" conversation-name="&lt;tag&gt;" backend="claude" backend-ref="" transcript-path="" debug-log-path="" status="new" last-activity-at="2026-01-01T00:00:00Z" />`;
    const attrs = parseConversationRefAttrs(raw);
    expect(attrs["project-name"]).toBe("P&Q");
    expect(attrs["conversation-name"]).toBe("<tag>");
  });

  it("produces an object that satisfies conversationRefAttrsSchema", () => {
    const attrs = parseConversationRefAttrs(SAMPLE_REF);
    const result = conversationRefAttrsSchema.safeParse(attrs);
    expect(result.success).toBe(true);
  });

  it("parses compact-* attributes when present", () => {
    const refs = findConversationRefs(`See ${COMPACT_REF} for context`);
    expect(refs).toHaveLength(1);
    const attrs = refs[0]!.attrs;
    expect(attrs["compact-artifact-id"]).toBe("art-1");
    expect(attrs["compact-status"]).toBe("fresh");
    expect(attrs["compact-covered-seq"]).toBe("0..421");
    expect(attrs["compact-created-at"]).toBe("2026-07-01T00:00:00Z");
  });

  it("still parses refs that carry only compact-status", () => {
    const raw = SAMPLE_REF.replace(" />", ' compact-status="none" />');
    const attrs = parseConversationRefAttrs(raw);
    expect(attrs["compact-status"]).toBe("none");
    expect(attrs["compact-artifact-id"]).toBeUndefined();
    expect(attrs["conversation-id"]).toBe("abc");
  });

  it("satisfies conversationRefAttrsSchema with compact attributes present", () => {
    const attrs = parseConversationRefAttrs(COMPACT_REF);
    const result = conversationRefAttrsSchema.safeParse(attrs);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["compact-status"]).toBe("fresh");
      expect(result.data["compact-artifact-id"]).toBe("art-1");
    }
  });

  it("satisfies conversationRefAttrsSchema for legacy refs without compact attributes", () => {
    const attrs = parseConversationRefAttrs(SAMPLE_REF);
    const result = conversationRefAttrsSchema.safeParse(attrs);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["compact-status"]).toBeUndefined();
    }
  });
});
