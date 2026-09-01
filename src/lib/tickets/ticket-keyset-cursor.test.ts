import { describe, expect, it } from "vitest";
import {
  compareTicketKeysetNewestFirst,
  decodeTicketKeysetCursor,
  encodeTicketKeysetCursor,
  isTicketKeysetRowAfterCursor,
  normalizeTicketPageLimit,
} from "./ticket-keyset-cursor";

describe("ticket keyset cursors", () => {
  it("round-trips only the timestamp and stable id", () => {
    const cursor = {
      timestamp: "2026-08-31T12:00:00.000Z",
      id: "update-20",
    };
    const encoded = encodeTicketKeysetCursor(cursor);

    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeTicketKeysetCursor(encoded)).toEqual(cursor);
    const decodedJson = Buffer.from(encoded, "base64url").toString("utf8");
    expect(decodedJson).not.toContain("bodyMarkdown");
    expect(decodedJson).not.toContain("description");
  });

  it.each([
    "",
    "not base64!",
    Buffer.from("not-json", "utf8").toString("base64url"),
    Buffer.from(JSON.stringify({ timestamp: "x" }), "utf8").toString(
      "base64url",
    ),
    Buffer.from(
      JSON.stringify({
        timestamp: "2026-08-31T12:00:00.000Z",
        id: "row-1",
        bodyMarkdown: "must not ride in a cursor",
      }),
      "utf8",
    ).toString("base64url"),
  ])("rejects malformed or widened cursor %j", (encoded) => {
    expect(decodeTicketKeysetCursor(encoded)).toBeNull();
  });

  it("orders equal timestamps by id descending without gaps", () => {
    const rows = ["row-a", "row-c", "row-b"].map((id) => ({
      timestamp: "2026-08-31T12:00:00.000Z",
      id,
    }));
    rows.sort(compareTicketKeysetNewestFirst);

    expect(rows.map(({ id }) => id)).toEqual(["row-c", "row-b", "row-a"]);
    expect(
      rows.filter((row) => isTicketKeysetRowAfterCursor(row, rows[1]!)),
    ).toEqual([rows[2]]);
  });

  it("orders older timestamps after the cursor", () => {
    const cursor = {
      timestamp: "2026-08-31T12:00:00.000Z",
      id: "row-a",
    };
    expect(
      isTicketKeysetRowAfterCursor(
        { timestamp: "2026-08-31T11:59:59.999Z", id: "row-z" },
        cursor,
      ),
    ).toBe(true);
    expect(
      isTicketKeysetRowAfterCursor(
        { timestamp: "2026-08-31T12:00:00.001Z", id: "row-a" },
        cursor,
      ),
    ).toBe(false);
  });
});

describe("ticket page limits", () => {
  it.each([undefined, null])("defaults absent %s to 20", (value) => {
    expect(normalizeTicketPageLimit(value)).toBe(20);
  });

  it.each([
    ["1", 1],
    [20, 20],
    ["100", 100],
  ] as const)("accepts %s as %i", (value, expected) => {
    expect(normalizeTicketPageLimit(value)).toBe(expected);
  });

  it.each(["", "0", 0, "101", 101, "1.5", 1.5, "many"])(
    "rejects invalid limit %j",
    (value) => {
      expect(normalizeTicketPageLimit(value)).toBeNull();
    },
  );
});
