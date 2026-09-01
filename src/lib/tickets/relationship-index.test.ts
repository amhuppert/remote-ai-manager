import { describe, expect, it } from "vitest";
import { RELATIONSHIP_DESCRIPTION_PREVIEW_CHARS } from "./disclosure-limits";
import {
  buildRelationshipIndex,
  relationshipDescriptionPreview,
  renderRelationshipIndexLines,
} from "./relationship-index";
import type { TicketRelationshipView } from "./schemas";

describe("relationshipDescriptionPreview", () => {
  it("normalizes whitespace and bounds the preview with an explicit ellipsis", () => {
    const preview = relationshipDescriptionPreview(
      `  first\n\nsecond\t${"x".repeat(RELATIONSHIP_DESCRIPTION_PREVIEW_CHARS * 2)}  `,
    );

    expect(preview).toHaveLength(RELATIONSHIP_DESCRIPTION_PREVIEW_CHARS);
    expect(preview).toMatch(/^first second x+/);
    expect(preview?.endsWith("…")).toBe(true);
  });

  it("preserves empty relationship descriptions", () => {
    expect(relationshipDescriptionPreview(" \n ")).toBe("");
    expect(relationshipDescriptionPreview(null)).toBeNull();
  });

  it("does not split Unicode code points at the boundary", () => {
    const preview = relationshipDescriptionPreview(
      "🫧".repeat(RELATIONSHIP_DESCRIPTION_PREVIEW_CHARS + 1),
    );

    expect(Array.from(preview ?? "")).toHaveLength(
      RELATIONSHIP_DESCRIPTION_PREVIEW_CHARS,
    );
    expect(preview?.endsWith("…")).toBe(true);
  });
});

function relationship(
  id: string,
  role: TicketRelationshipView["role"],
  updatedAt: string,
): TicketRelationshipView {
  return {
    id,
    role,
    otherTicket: {
      id: `ticket-${id}`,
      projectName: "other project",
      number: 7,
      title: `Title ${id}`,
      status: "blocked",
    },
    description: `Rationale ${id} ${"secret".repeat(60)}`,
    createdAt: updatedAt,
    updatedAt,
  };
}

describe("buildRelationshipIndex", () => {
  it("groups bounded outlines by relative role with stable handles and exact commands", () => {
    const relationships: TicketRelationshipView[] = [
      relationship("related", "related", "2026-01-01T00:00:00.000Z"),
      relationship("blocks", "blocks", "2026-01-02T00:00:00.000Z"),
      relationship("child", "child", "2026-01-03T00:00:00.000Z"),
      relationship("parent", "parent", "2026-01-04T00:00:00.000Z"),
      relationship("depends", "depends_on", "2026-01-05T00:00:00.000Z"),
    ];

    const index = buildRelationshipIndex({
      identifier: "demo project#2",
      relationships,
    });

    expect(index.entries.map(({ role }) => role)).toEqual([
      "parent",
      "child",
      "depends_on",
      "blocks",
      "related",
    ]);
    expect(index.entries[0]).toMatchObject({
      relationshipId: "parent",
      otherTicketIdentifier: "other project#7",
      status: "blocked",
      title: "Title parent",
      command: "cctl ticket relation get 'demo project#2' 'parent'",
    });
    expect(Array.from(index.entries[0]?.descriptionPreview ?? "")).toHaveLength(
      RELATIONSHIP_DESCRIPTION_PREVIEW_CHARS,
    );
    expect(index.entries[0]?.descriptionPreview.endsWith("…")).toBe(true);
    expect(index).toMatchObject({
      total: 5,
      returned: 5,
      truncated: false,
      listCommand: "cctl ticket relation list 'demo project#2'",
    });
  });

  it("caps rows independently of data and names the exact omitted-list command", () => {
    const relationships = Array.from({ length: 23 }, (_, index) =>
      relationship(
        `rel-${String(index).padStart(2, "0")}`,
        "related",
        `2026-01-01T00:00:${String(index).padStart(2, "0")}.000Z`,
      ),
    );

    const index = buildRelationshipIndex({
      identifier: "demo#1",
      relationships,
    });
    const lines = renderRelationshipIndexLines(index);

    expect(index.entries).toHaveLength(20);
    expect(index).toMatchObject({ total: 23, returned: 20, truncated: true });
    expect(lines.at(-1)).toBe(
      "relationships: 23 total, 20 returned, truncated=yes; rest: cctl ticket relation list 'demo#1'",
    );
  });
});
