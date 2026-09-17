import { assertMediaType, assertText, frozenJson } from "./validation.js";
import { retentionMetadataName } from "./artifact-retention.js";
const binarySources = new WeakMap();
/** Shared request/writer metadata ingress, independent of host acquisition. */
export function assertArtifactBasename(basename) {
    assertText(basename);
    if (basename === "." || basename === ".." || retentionMetadataName(basename) || /[/\\]/.test(basename)
        || new TextEncoder().encode(basename).length > 128)
        throw new TypeError("Invalid artifact basename.");
}
export function makeBinaryRequest(input) {
    if (!input || typeof input !== "object" || ![Object.prototype, null].includes(Object.getPrototypeOf(input)))
        throw new TypeError("Expected a binary request record.");
    const keys = Reflect.ownKeys(input);
    const fields = ["bytes", "mediaType", "basename", "summary"];
    if (keys.length !== fields.length || fields.some(key => !Object.hasOwn(input, key))
        || keys.some(key => { const descriptor = Object.getOwnPropertyDescriptor(input, key); return !descriptor?.enumerable || !("value" in descriptor); })) {
        throw new TypeError("Binary requests require exactly four enumerable data properties.");
    }
    if (!(input.bytes instanceof Uint8Array))
        throw new TypeError("Expected finite bytes in a Uint8Array.");
    const snapshot = new Uint8Array(input.bytes);
    assertArtifactBasename(input.basename);
    assertMediaType(input.mediaType);
    const summary = frozenJson(input.summary);
    const value = {
        get bytes() { return new Uint8Array(snapshot); }, mediaType: input.mediaType, basename: input.basename, summary,
    };
    const request = Object.freeze(value);
    binarySources.set(request, snapshot);
    return request;
}
export function checkBinaryRequest(value) {
    if (value === null || typeof value !== "object" || !binarySources.has(value))
        throw new TypeError("Unknown or forged binary request.");
}
/** Only an owned finite request reaches the writer; every observation is detached. */
export function binaryBytes(request) {
    const retained = binarySources.get(request);
    if (!retained)
        throw new TypeError("Unknown or forged binary request.");
    return new Uint8Array(retained);
}
//# sourceMappingURL=binary.js.map