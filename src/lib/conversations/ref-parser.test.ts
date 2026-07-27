import { describe, it, expect } from "vitest";
import {
  findConversationRefs,
  findTicketRefs,
  parseRefAttrs,
} from "./ref-parser";
import { conversationRefAttrsSchema } from "./schemas";

const SAMPLE_REF =
  '<conversation-ref project-name="proj" project-path="/p" scope="session" session-name="sess" worktree-path="/w" conversation-id="abc" conversation-name="Hello" backend="claude" backend-ref="sid-1" transcript-path="/t.jsonl" debug-log-path="" status="awaiting" last-activity-at="2026-01-01T00:00:00Z" />';

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

const TICKET_REF =
  '<ticket-ref project-name="command-center" ticket-number="12" identifier="command-center#12" title="Add durable ticket context" read-command="cctl ticket get command-center#12" />';

describe("findTicketRefs", () => {
  it("finds a ticket ref in plain text with its attribute map", () => {
    const refs = findTicketRefs(`Please pick up ${TICKET_REF} next.`);
    expect(refs).toHaveLength(1);
    expect(refs[0]?.raw).toBe(TICKET_REF);
    expect(refs[0]?.attrs["identifier"]).toBe("command-center#12");
    expect(refs[0]?.attrs["ticket-number"]).toBe("12");
    expect(refs[0]?.attrs["read-command"]).toBe(
      "cctl ticket get command-center#12",
    );
  });

  it("skips ticket refs inside fenced code blocks", () => {
    expect(
      findTicketRefs(`Before\n\`\`\`\n${TICKET_REF}\n\`\`\`\nAfter`),
    ).toHaveLength(0);
    expect(
      findTicketRefs(`Before\n~~~\n${TICKET_REF}\n~~~\nAfter`),
    ).toHaveLength(0);
  });

  it("does not match malformed tags", () => {
    expect(findTicketRefs("<ticket-ref/>")).toHaveLength(0);
    expect(
      findTicketRefs("<ticket-ref project-name=command-center />"),
    ).toHaveLength(0);
    expect(
      findTicketRefs('<ticket-ref project-name="command-center">'),
    ).toHaveLength(0);
  });
});

describe("parseRefAttrs", () => {
  it("returns the full attribute map for a well-formed ref", () => {
    const attrs = parseRefAttrs(SAMPLE_REF);
    expect(attrs["project-name"]).toBe("proj");
    expect(attrs["backend"]).toBe("claude");
    expect(attrs["debug-log-path"]).toBe("");
  });

  it("decodes XML entities in attribute values", () => {
    const raw = `<conversation-ref project-name="P&amp;Q" project-path="/p" scope="session" session-name="s" worktree-path="/w" conversation-id="abc" conversation-name="&lt;tag&gt;" backend="claude" backend-ref="" transcript-path="" debug-log-path="" status="new" last-activity-at="2026-01-01T00:00:00Z" />`;
    const attrs = parseRefAttrs(raw);
    expect(attrs["project-name"]).toBe("P&Q");
    expect(attrs["conversation-name"]).toBe("<tag>");
  });

  it("produces an object that satisfies conversationRefAttrsSchema", () => {
    const attrs = parseRefAttrs(SAMPLE_REF);
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
    const attrs = parseRefAttrs(raw);
    expect(attrs["compact-status"]).toBe("none");
    expect(attrs["compact-artifact-id"]).toBeUndefined();
    expect(attrs["conversation-id"]).toBe("abc");
  });

  it("satisfies conversationRefAttrsSchema with compact attributes present", () => {
    const attrs = parseRefAttrs(COMPACT_REF);
    const result = conversationRefAttrsSchema.safeParse(attrs);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["compact-status"]).toBe("fresh");
      expect(result.data["compact-artifact-id"]).toBe("art-1");
    }
  });

  it("satisfies conversationRefAttrsSchema for legacy refs without compact attributes", () => {
    const attrs = parseRefAttrs(SAMPLE_REF);
    const result = conversationRefAttrsSchema.safeParse(attrs);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["compact-status"]).toBeUndefined();
    }
  });

  it("parses read-command / compaction-command whose values carry spaces and flags", () => {
    const raw = SAMPLE_REF.replace(
      " />",
      ' compact-status="fresh" compaction-command="cctl conversation compaction get abc --json" read-command="cctl conversation read abc --outline" />',
    );
    const refs = findConversationRefs(`Context: ${raw}`);
    expect(refs).toHaveLength(1);
    const result = conversationRefAttrsSchema.safeParse(refs[0]!.attrs);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["compaction-command"]).toBe(
        "cctl conversation compaction get abc --json",
      );
      expect(result.data["read-command"]).toBe(
        "cctl conversation read abc --outline",
      );
    }
  });
});
