import { describe, expect, it } from "vitest";

import { providerRefDigest } from "./provider-ref-digest";

describe("providerRefDigest", () => {
  it("does not carry the reference it describes", () => {
    const ref = "01a0837d-de3d-7b22-8f0c-7320ac0cc038";
    const digest = providerRefDigest(ref);

    expect(digest).not.toBeNull();
    expect(digest).not.toContain(ref);
    // A partial leak is still a leak: no run of the reference survives.
    expect(digest).not.toContain("01a0837d");
  });

  it("is stable, so two turns on one reference are recognisably the same", () => {
    const ref = "session-abc";

    expect(providerRefDigest(ref)).toBe(providerRefDigest(ref));
  });

  it("separates references, so a checkpoint's change of reference is visible", () => {
    expect(providerRefDigest("thread-before")).not.toBe(
      providerRefDigest("thread-after"),
    );
  });

  it("reports absence rather than inventing a digest", () => {
    expect(providerRefDigest(null)).toBeNull();
    expect(providerRefDigest(undefined)).toBeNull();
    expect(providerRefDigest("")).toBeNull();
  });

  it("matches the digest form protected evidence and receipts already use", () => {
    expect(providerRefDigest("ref")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
