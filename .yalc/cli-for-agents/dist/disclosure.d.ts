import type { Invocation } from "./commands.js";
import type { Brand } from "./internal/brand.js";
import type { ArtifactPath, Bytes, Count, JsonData, JsonValue, Sha256 } from "./values.js";
/** Dataset total, not the number remaining after a cursor. */
export type Total = {
    readonly kind: "known";
    readonly count: Count;
} | {
    readonly kind: "unknown";
    readonly count?: never;
};
/** A complete result cannot promise more; any truncation must carry a read-only route. */
export type Omission = {
    readonly truncated: false;
    readonly returned: Count;
    readonly total: Total;
    readonly reveal?: never;
} | {
    readonly truncated: true;
    readonly returned: Count;
    readonly total: Total;
    readonly reveal: Invocation<"read">;
};
export type Page<Item> = {
    readonly items: readonly JsonData<Item>[];
    readonly omission: Omission;
};
/** Accepts an already-paged source; it never loads an entire dataset to slice it. */
export declare function page<Item>(source: {
    readonly items: readonly JsonData<Item>[];
    readonly total: Total;
} & ({
    readonly more: false;
    readonly reveal?: never;
} | {
    readonly more: true;
    readonly reveal: Invocation<"read">;
})): Page<Item>;
/** Only delivery can create manifests after an atomic, policy-checked write. */
export type ArtifactManifest = Brand<"ArtifactManifest"> & {
    readonly path: ArtifactPath;
    readonly format: "json" | "text" | "binary";
    readonly mediaType: string;
    readonly bytes: Bytes;
    readonly sha256: Sha256;
    readonly reason: "stdout_budget_exceeded" | "explicit_out" | "binary_request";
    readonly contains: "response" | "data" | "binary";
};
type PayloadShape<Data> = {
    readonly kind: "inline";
    readonly data: Data;
    readonly artifact?: never;
    readonly summary?: never;
} | {
    readonly kind: "artifact";
    readonly summary: JsonValue;
    readonly artifact: ArtifactManifest;
    readonly data?: never;
};
/** Preserves an application's DTO shape while excluding values JSON cannot represent. */
export type Payload<Data> = PayloadShape<JsonData<Data>>;
/** Framework payload with an anchored JSON value; no recursive DTO projection is needed. */
export type AnyPayload = PayloadShape<JsonValue>;
/** Applied to automatic spill and --out alike; canonical paths must avoid forbidden roots. */
export type ArtifactPolicy = {
    readonly directory: string;
    /** Resolve roots and destination ancestors through symlinks before checking containment. */
    readonly forbiddenRoots: readonly string[];
    /** Retention defaults to off. Unrelated existing --out files are always refused. */
    readonly retention?: {
        readonly maxAgeMs: import("./values.js").Milliseconds;
    };
};
/** Finite bytes are never JSON data or a streaming source. The constructor validates
 * media type/basename/JSON summary and snapshots bytes before retaining the request.
 */
type BinaryRequestShape<Summary> = Brand<"BinaryArtifactRequest"> & {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly basename: string;
    readonly summary: Summary;
};
export type BinaryArtifactRequest<Summary> = BinaryRequestShape<JsonData<Summary>>;
export type AnyBinaryArtifactRequest = BinaryRequestShape<JsonValue>;
export declare function binaryArtifact<Summary>(request: {
    readonly bytes: Uint8Array;
    readonly mediaType: string;
    readonly basename: string;
    readonly summary: JsonData<Summary>;
}): BinaryArtifactRequest<Summary>;
/** Immutable, canonical, app-free value retained by the post-operation hook. */
export type ResolvedArtifactPolicy = Readonly<ArtifactPolicy> & Brand<"ResolvedArtifactPolicy">;
export {};
//# sourceMappingURL=disclosure.d.ts.map