export interface GridShape {
  cols: number;
  rows: number;
  shape: string;
}

export function gridShape(n: number): GridShape {
  const clamped = Math.min(6, Math.max(1, n));
  switch (clamped) {
    case 1:
      return { cols: 1, rows: 1, shape: "row" };
    case 2:
      return { cols: 2, rows: 1, shape: "row" };
    case 3:
      return { cols: 3, rows: 1, shape: "row" };
    case 4:
      return { cols: 2, rows: 2, shape: "grid-2x2" };
    case 5:
      // 6-col track so the top row holds 3 panes each spanning 2 cols and the
      // bottom row holds 2 panes each spanning 3 cols (the asymmetric "three
      // over two wider").
      return { cols: 6, rows: 2, shape: "asym-5" };
    default:
      return { cols: 3, rows: 2, shape: "grid-3x2" };
  }
}

export function paneMessageLimit(paneCount: number): number {
  if (paneCount === 2) return 4;
  return 2;
}

export function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}
