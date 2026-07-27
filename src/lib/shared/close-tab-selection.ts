export function closeTabSelection(
  orderedTabIds: readonly string[],
  closingTabId: string,
): string | null {
  const closingIndex = orderedTabIds.indexOf(closingTabId);
  if (closingIndex < 0) return null;

  return (
    orderedTabIds[closingIndex - 1] ?? orderedTabIds[closingIndex + 1] ?? null
  );
}
