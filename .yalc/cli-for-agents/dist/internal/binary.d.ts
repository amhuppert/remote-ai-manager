import type { AnyBinaryArtifactRequest, BinaryArtifactRequest } from "../disclosure.js";
import type { JsonData } from "../values.js";
/** Shared request/writer metadata ingress, independent of host acquisition. */
export declare function assertArtifactBasename(basename: unknown): void;
/** Bytes and summary are snapshotted at construction; the request is a frozen record. */
export declare function makeBinaryRequest<Summary>(input: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly basename: string;
    readonly summary: JsonData<Summary>;
}): BinaryArtifactRequest<Summary>;
export declare function checkBinaryRequest(value: unknown): asserts value is AnyBinaryArtifactRequest;
/** The writer snapshots again before awaiting, so later mutation cannot reach the file. */
export declare function binaryBytes(request: AnyBinaryArtifactRequest): Uint8Array;
//# sourceMappingURL=binary.d.ts.map