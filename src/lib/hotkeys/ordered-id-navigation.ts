export type OrderedIdDirection = "next" | "previous";

export function getOrderedIdForShortcut(
  orderedIds: readonly string[],
  key: string,
): string | null {
  if (!/^[1-9]$/.test(key)) return null;
  return orderedIds[Number(key) - 1] ?? null;
}

export function getAdjacentOrderedId(
  orderedIds: readonly string[],
  activeId: string | null,
  direction: OrderedIdDirection,
): string | null {
  if (orderedIds.length === 0) return null;

  const activeIndex = activeId === null ? -1 : orderedIds.indexOf(activeId);
  if (activeIndex === -1) {
    return direction === "next"
      ? (orderedIds[0] ?? null)
      : (orderedIds.at(-1) ?? null);
  }

  const offset = direction === "next" ? 1 : -1;
  const targetIndex =
    (activeIndex + offset + orderedIds.length) % orderedIds.length;
  return orderedIds[targetIndex] ?? null;
}
