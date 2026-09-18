import { assertMediaType, assertText, frozenJson } from "./validation.js";
/** Shared request/writer metadata ingress, independent of host acquisition. */
export function assertArtifactBasename(basename) {
    assertText(basename);
    if (basename === "." || basename === ".." || /[/\\]/.test(basename)
        || new TextEncoder().encode(basename).length > 128)
        throw new TypeError("Invalid artifact basename.");
}
/** Bytes and summary are snapshotted at construction; the request is a frozen record. */
export function makeBinaryRequest(input) {
    if (input === null || typeof input !== "object")
        throw new TypeError("Expected a binary request record.");
    if (!(input.bytes instanceof Uint8Array))
        throw new TypeError("Expected finite bytes in a Uint8Array.");
    assertArtifactBasename(input.basename);
    assertMediaType(input.mediaType);
    const summary = frozenJson(input.summary);
    return Object.freeze({ bytes: new Uint8Array(input.bytes), mediaType: input.mediaType, basename: input.basename, summary });
}
export function checkBinaryRequest(value) {
    if (value === null || typeof value !== "object" || !("bytes" in value) || !(value.bytes instanceof Uint8Array)
        || !("mediaType" in value) || !("basename" in value) || !("summary" in value))
        throw new TypeError("Expected a binary artifact request.");
    assertArtifactBasename(value.basename);
    assertMediaType(value.mediaType);
}
/** The writer snapshots again before awaiting, so later mutation cannot reach the file. */
export function binaryBytes(request) {
    checkBinaryRequest(request);
    return new Uint8Array(request.bytes);
}
//# sourceMappingURL=binary.js.map