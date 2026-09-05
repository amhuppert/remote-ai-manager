import { describe, expect, it } from "vitest";
import { encodeTicketBundle, decodeTicketBundle } from "./bundle";

import { bundleFixture } from "./bundle.fixtures";

describe("portable ticket archive", () => {
  it("round trips all bytes and original paths with verified integrity", async () => {
    const source = bundleFixture();
    const bytes = await encodeTicketBundle(source);
    const result = await decodeTicketBundle(bytes);
    expect(result.ticket).toEqual(source.ticket);
    expect(result.documents[0]?.source).toBe("/old/repo/design.md");
    expect(
      Buffer.from(result.documents[0]?.content ?? "", "base64").toString(),
    ).toBe("Decision\n");
    expect(result.documents[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});

it("rejects a modified document rather than importing corrupted bytes", async () => {
  const { gzipSync } = await import("node:zlib");
  const encoded = await encodeTicketBundle(bundleFixture());
  const parsed = await decodeTicketBundle(encoded);
  parsed.documents[0]!.content = Buffer.from("tampered").toString("base64");
  await expect(
    decodeTicketBundle(gzipSync(JSON.stringify(parsed))),
  ).rejects.toThrow(/integrity/);
  const unsupported = { ...(await decodeTicketBundle(encoded)), version: 2 };
  await expect(
    decodeTicketBundle(gzipSync(JSON.stringify(unsupported))),
  ).rejects.toThrow(/unsupported/);
});
