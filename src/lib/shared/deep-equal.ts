/**
 * Structural deep-equality for JSON-shaped data: primitives, plain objects,
 * arrays, and `null`. A browser-safe replacement for `node:util`'s
 * `isDeepStrictEqual` on the Zod-parsed plain-data values CC compares (context
 * and task runtime states, resolved-config drafts) — those carry no `Date`,
 * `Map`, `Set`, `RegExp`, or class instances, so structural key/element
 * comparison suffices.
 *
 * Parity with `isDeepStrictEqual` on this data class: primitives compare via
 * `Object.is` (so `NaN` equals `NaN`, `-0` differs from `+0`); objects compare
 * own-enumerable keys, so a present-but-`undefined` key differs from a missing
 * one; arrays are length- and order-sensitive and never equal a plain object.
 */
export function deepEqualJson(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    a === null ||
    typeof b !== "object" ||
    b === null
  ) {
    return false;
  }

  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;

  if (aIsArray) {
    const aArr = a as unknown[];
    const bArr = b as unknown[];
    if (aArr.length !== bArr.length) return false;
    for (let i = 0; i < aArr.length; i++) {
      if (!deepEqualJson(aArr[i], bArr[i])) return false;
    }
    return true;
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(bObj, key)) return false;
    if (!deepEqualJson(aObj[key], bObj[key])) return false;
  }
  return true;
}
