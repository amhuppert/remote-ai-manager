import { expect } from "vitest";

/**
 * Assert two byte sequences are identical.
 *
 * `expect(buffer).toEqual(other)` walks both buffers element by element
 * through the generic deep-equality matcher, which costs seconds per
 * comparison on a serialized SQLite database. This compares natively and
 * only reports through `expect` on mismatch, naming the first differing
 * offset so a failure is still diagnosable.
 */
export function expectSameBytes(
  actual: Uint8Array,
  expected: Uint8Array,
  label = "bytes",
): void {
  if (
    actual.byteLength === expected.byteLength &&
    Buffer.compare(actual, expected) === 0
  ) {
    return;
  }
  const limit = Math.min(actual.byteLength, expected.byteLength);
  let offset = 0;
  while (offset < limit && actual[offset] === expected[offset]) offset += 1;
  expect.fail(
    `${label} differ: actual ${actual.byteLength} bytes, expected ${expected.byteLength} bytes, first difference at offset ${offset}`,
  );
}
