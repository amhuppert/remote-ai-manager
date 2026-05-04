/**
 * Anchor-point helpers for laying out edges between StateNodes. All layouts
 * use these instead of repeating x + width/2 math inline.
 */

import type { NodeBox, Point } from "./types";

export function topAnchor(b: NodeBox, dx = 0): Point {
  return { x: b.x + b.width / 2 + dx, y: b.y };
}

export function bottomAnchor(b: NodeBox, dx = 0): Point {
  return { x: b.x + b.width / 2 + dx, y: b.y + b.height };
}

export function leftAnchor(b: NodeBox, dy = 0): Point {
  return { x: b.x, y: b.y + b.height / 2 + dy };
}

export function rightAnchor(b: NodeBox, dy = 0): Point {
  return { x: b.x + b.width, y: b.y + b.height / 2 + dy };
}

export function centerAnchor(b: NodeBox): Point {
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Box constructor that forwards width/height defaults from the layout. */
export function box(x: number, y: number, width = 200, height = 56): NodeBox {
  return { x, y, width, height };
}
