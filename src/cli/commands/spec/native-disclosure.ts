import { count, type Invocation, type Omission } from "cli-for-agents";

export function boundSpecRows<T>(
  rows: readonly T[],
  reveal: Invocation<"read">,
): { items: T[]; omission: Omission } {
  const items = rows.slice(0, 10);
  const totals = {
    returned: count(items.length),
    total: { kind: "known", count: count(rows.length) },
  } as const;
  return {
    items,
    omission:
      items.length < rows.length
        ? { ...totals, truncated: true, reveal }
        : { ...totals, truncated: false },
  };
}
