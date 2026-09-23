import { bytes, milliseconds } from "../values.js";
export function checkLimit(limit) { bytes(limit); }
export function checkDuration(duration) { milliseconds(duration); }
export class InputOverflowError extends RangeError {
    constructor() { super("Input exceeds byte limit"); }
}
export function overflow() { return new InputOverflowError(); }
export class ArtifactCollisionError extends Error {
    constructor() { super("Atomic write collision: existing file differs"); }
}
export function collisionError() { return new ArtifactCollisionError(); }
export function sameBytes(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
export async function hashBytes(data) {
    const snapshot = new Uint8Array(data);
    const { createHash } = await import("node:crypto");
    return createHash("sha256").update(snapshot).digest("hex");
}
export function hasCode(error, code) {
    return error instanceof Error && "code" in error && error.code === code;
}
//# sourceMappingURL=host.js.map