import { describe, expect, it } from "vitest";

import { parseTicketNumberSegment } from "./ticket-number";

describe("parseTicketNumberSegment", () => {
  it.each([
    ["1", 1],
    ["12", 12],
    ["9007199254740991", Number.MAX_SAFE_INTEGER],
  ] as const)("parses the canonical ticket segment %j", (segment, expected) => {
    expect(parseTicketNumberSegment(segment)).toBe(expected);
  });

  it.each(["0", "0xC", "1e2", " 12 ", "+12", "012", "9007199254740992"])(
    "rejects the noncanonical ticket segment %j",
    (segment) => {
      expect(parseTicketNumberSegment(segment)).toBeNull();
    },
  );
});
