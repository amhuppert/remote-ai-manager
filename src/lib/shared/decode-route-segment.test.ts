import { describe, expect, it } from "vitest";

import { decodeRouteSegment } from "./decode-route-segment";

describe("decodeRouteSegment", () => {
  it("decodes one framework route-segment encoding layer", () => {
    expect(decodeRouteSegment("literal%20project")).toBe("literal project");
  });

  it("preserves a literal encoded-looking project name", () => {
    expect(decodeRouteSegment("literal%2520project")).toBe("literal%20project");
  });

  it("leaves malformed percent text usable", () => {
    expect(decodeRouteSegment("malformed%project")).toBe("malformed%project");
  });
});
