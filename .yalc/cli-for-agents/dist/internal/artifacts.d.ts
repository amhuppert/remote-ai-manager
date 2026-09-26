import type { ArtifactPolicy, ResolvedArtifactPolicy, ArtifactManifest, AnyBinaryArtifactRequest } from "../disclosure.js";
import type { Host, RunResult } from "../runtime/index.js";
import type { AssembledResponse } from "./response.js";
import type { SecondaryFailure } from "../results.js";
import type { Bytes } from "../values.js";
/** Framework-owned policy failure; resolver and host exception text never reaches output. */
export declare class ArtifactPolicyError extends TypeError {
    readonly failure: SecondaryFailure;
    constructor(failure: SecondaryFailure);
}
/** Detached app-free policy, or its deferred failure, captured before release.
 * Filesystem work waits until delivery actually needs an artifact. */
export type CapturedArtifactPolicy = {
    readonly ok: true;
    readonly policy: ArtifactPolicy;
    readonly failure?: never;
} | {
    readonly ok: false;
    readonly failure: SecondaryFailure;
    readonly policy?: never;
};
export declare function captureArtifactPolicy(value: unknown): CapturedArtifactPolicy;
/** Delivery-time preparation of a captured policy: canonicalize, refuse forbidden
 * containment before creating anything, then ensure only the configured root. */
export declare function resolveArtifactPolicy(policy: ArtifactPolicy, host: Host, signal: AbortSignal): Promise<ResolvedArtifactPolicy>;
/** One bounded writer for automatic spill, explicit out and finite binary exports. */
export declare function writeArtifact(request: {
    readonly bytes: Uint8Array;
    readonly format: ArtifactManifest["format"];
    readonly mediaType: string;
    readonly basename: string;
    readonly out?: string;
    readonly reason: ArtifactManifest["reason"];
    readonly contains: ArtifactManifest["contains"];
}, policy: ResolvedArtifactPolicy, host: Host, signal: AbortSignal): Promise<ArtifactManifest>;
/** Binary requests always reach writeArtifact; no inline or raw-byte bypass. */
export declare function deliverBinary(request: AnyBinaryArtifactRequest, policy: ResolvedArtifactPolicy, host: Host, signal: AbortSignal, out?: string): Promise<ArtifactManifest>;
/** Pure pre-execution check; runtime-composition invokes before loading handlers. */
export declare function validateOutputBudget(budget?: Bytes): Bytes;
/** Count only the final serialized streams, including framing and newlines. */
export declare function measureOutput(output: {
    readonly stdout: string;
    readonly stderr: string;
}): Bytes;
/** The final bound for every response class. Measures serialized UTF-8 across both
 * streams, spills/omits optional detail and retains valid required protocol fields.
 * Delivery failures preserve primary classification and known effect/recovery;
 * they never re-arbitrate guidance or dump an oversized body. Only this owner
 * constructs bounded RunResult; runtime-composition invokes it after assembly.
 */
export declare function deliver(response: AssembledResponse, options: {
    readonly format: "text" | "json";
    readonly budget: Bytes;
    /** Absent when no app-free policy exists; optional spill then omits detail inline. */
    readonly artifacts?: CapturedArtifactPolicy;
    readonly host: Host;
    readonly signal: AbortSignal;
    readonly out?: string;
}): Promise<RunResult>;
//# sourceMappingURL=artifacts.d.ts.map