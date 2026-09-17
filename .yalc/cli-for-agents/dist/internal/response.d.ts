import type { ExecutionResult } from "./execution.js";
import type { EvaluatedGuidance, HandlerGuidance, FinalGuidance, GuidanceConflict, ConflictSink } from "../guidance/index.js";
import type { AnyBinaryArtifactRequest } from "../disclosure.js";
import type { Invocation } from "../commands.js";
import type { AnyEnvelope, Issue, SecondaryFailure } from "../results.js";
import type { Brand } from "./brand.js";
export type ArbitrationInput = {
    readonly commandPath: string;
    readonly handler: HandlerGuidance;
    readonly candidates: readonly EvaluatedGuidance[];
    readonly conflictSink: ConflictSink;
};
export type ArbitratedGuidance = Brand<"ArbitratedGuidance"> & {
    readonly guidance: FinalGuidance;
    readonly conflict?: GuidanceConflict;
    readonly issues: readonly Issue[];
    /** Contract-invalid sources are isolated without losing other valid protocol. */
    readonly failures?: readonly SecondaryFailure[];
};
/** The only arbiter: handler plus local and authoritative candidates enter once. */
export declare function arbitrate(input: ArbitrationInput): Promise<ArbitratedGuidance>;
/** Structured handoff, not a final byte-bound promise. Delivery owns spill and limits. */
export type AssembledResponse = Brand<"AssembledResponse"> & {
    readonly envelope: AnyEnvelope;
    readonly guidance: FinalGuidance;
    readonly primaryText: string;
    readonly executable: string;
    readonly binary?: AnyBinaryArtifactRequest;
};
/** Runtime calls this after release; artifact-delivery consumes the result as-is. */
export declare function assembleResponse(execution: ExecutionResult, options: {
    readonly guidance: ArbitratedGuidance;
    readonly doctor: Invocation<"read">;
    readonly executable: string;
    readonly secondary: readonly SecondaryFailure[];
}): Promise<AssembledResponse>;
/** Unbounded pure projection. Only artifact delivery can turn this into RunResult. */
export declare function renderResponse(response: AssembledResponse, format: "text" | "json", compactReferences?: boolean): {
    readonly stdout: string;
    readonly stderr: string;
    readonly exitCode: import("../results.js").ExitCode;
};
/** Deterministic fallback over already validated JSON DTOs. */
export declare function renderStructural(data: unknown): string;
//# sourceMappingURL=response.d.ts.map