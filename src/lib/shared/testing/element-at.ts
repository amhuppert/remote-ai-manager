/**
 * Definite element access for tests, replacing the non-null assertion that
 * indexing otherwise invites.
 *
 * Under `noUncheckedIndexedAccess` an index read yields `T | undefined`, so a
 * test reaching through it needs either an assertion or a check. An assertion
 * trades the typed guarantee for a deref that surfaces as a confusing
 * `Cannot read properties of undefined` inside whatever expectation ran next;
 * this narrows with a real check and fails immediately, naming the index and
 * the length that was actually there.
 */
export function elementAt<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(
      `expected an element at index ${index}, but the collection holds ${items.length}`,
    );
  }
  return item;
}

/**
 * The single element of a collection expected to hold exactly one, so a test
 * asserting on "the" element also pins that nothing else arrived.
 */
export function onlyElement<T>(items: readonly T[]): T {
  if (items.length !== 1) {
    throw new Error(`expected exactly one element, but saw ${items.length}`);
  }
  return elementAt(items, 0);
}
