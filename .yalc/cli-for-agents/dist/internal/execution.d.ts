import type { ErrorDefinitions, FamilyCode, OperationOutcome, UnknownAcknowledgment, Issue, SecondaryFailure } from "../results.js";
import type { ContextProviders, ResolvedRunRequest, PostOperationContext } from "../runtime/index.js";
import type { EvaluatedGuidance } from "../guidance/index.js";
import type { ResolvedArtifactPolicy } from "../disclosure.js";
import type { Flag } from "../input.js";
import type { Sha256 } from "../values.js";
import type { Brand } from "./brand.js";
import type { AnyResult } from "../results.js";
import type { JsonValue } from "../values.js";
import type { ParsedInvocation } from "./registry.js";
/** Only execution stamps this after validating module reports and run-scoped tokens. */
export type ExecutionResult<Code extends string = string> = OperationOutcome<Code> & Brand<"ExecutionResult"> & {
    /** Exact checked runner/level renderer closed over validated data (or binary
     * summary) only. Response calls this after release; artifact-delivery bounds the assembled output.
     * Default structural rendering uses the same seam; throws are secondary output failures. */
    readonly renderPrimary: () => string;
    /** Help, version and exit-code text is framework output, not a handler primary. */
    readonly offline: boolean;
};
/** Uses only registry path and the already-computed payload hash; no durable ID is invented. */
export declare function unknownAcknowledgment<Contexts, Code extends string, G extends Readonly<Record<string, Flag>>>(invocation: ParsedInvocation<Contexts, Code, G>, payloadHash?: Sha256): UnknownAcknowledgment;
/** Hook facts must be detached from app before the finalizer; delivery is host-only. */
export type PostOperationFacts = {
    /** Missing when no guidance is configured or the provider failed. */
    readonly guidance?: EvaluatedGuidance;
    /** Missing when policy resolution fails; collected guidance still survives. */
    readonly artifacts?: ResolvedArtifactPolicy;
    readonly issues: readonly Issue[];
};
/** The runtime hook catches each collection/policy failure and returns accumulated
 * guidance/issues even when policy resolution fails. Do not throw away earlier
 * valid batches because a later step rejects; execution finalizes after settlement. */
export type PostOperationHook<Contexts> = (input: PostOperationContext<Contexts>) => Promise<PostOperationFacts>;
export type CompletedExecution<Code extends string = string> = {
    readonly execution: ExecutionResult<Code>;
    readonly secondary: readonly SecondaryFailure[];
} & ({
    readonly postOperation: "completed";
    readonly facts: PostOperationFacts;
} | {
    readonly postOperation: "failed";
    readonly facts?: PostOperationFacts;
} | {
    readonly postOperation: "skipped";
    readonly facts?: never;
});
/** Composition may repair optional references while preserving the observed operation. */
export declare function withExecutionResult(execution: ExecutionResult, result: AnyResult): ExecutionResult;
/** Offline routes have no application operation; reuse the execution outcome owner. */
export declare function offlineExecution(data: JsonValue, render: () => string): ExecutionResult;
export declare function usageExecution(issues: readonly Issue[]): ExecutionResult;
export declare function execute<Contexts, D extends ErrorDefinitions, G extends Readonly<Record<string, Flag>>>(invocation: ParsedInvocation<Contexts, FamilyCode<D>, G>, request: ResolvedRunRequest, contexts: ContextProviders<Contexts, D, G>, postOperation: PostOperationHook<Contexts>): Promise<CompletedExecution<FamilyCode<D>>>;
//# sourceMappingURL=execution.d.ts.map