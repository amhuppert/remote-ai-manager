import type { Invocation } from "./commands.js";
import type { HandlerGuidance, WireGuidance } from "./guidance/index.js";
import type { AnyPayload, Payload, AnyBinaryArtifactRequest } from "./disclosure.js";
import type { Brand } from "./internal/brand.js";
import type { JsonData, JsonValue, NonEmpty, Sha256 } from "./values.js";
/** Canonical finite kernel catalog: every owner imports this table, never a sibling map. */
export declare const kernelErrors: {
    readonly KERNEL_USAGE: {
        readonly exitClass: "usage";
        readonly description: "The invocation does not match the declared CLI contract.";
    };
    readonly KERNEL_CONTRACT: {
        readonly exitClass: "failed";
        readonly description: "An application or protocol value violated its declared contract.";
    };
    readonly KERNEL_INPUT: {
        readonly exitClass: "usage";
        readonly description: "Local file, JSON or schema input could not be validated.";
    };
    readonly KERNEL_CANCELLED: {
        readonly exitClass: "failed";
        readonly description: "The operation was cancelled.";
    };
    readonly KERNEL_HANDLER: {
        readonly exitClass: "failed";
        readonly description: "The handler did not return an acknowledged outcome.";
    };
    readonly KERNEL_CONTEXT: {
        readonly exitClass: "connection";
        readonly description: "The required application context could not be acquired.";
    };
    readonly KERNEL_GUIDANCE: {
        readonly exitClass: "failed";
        readonly description: "Required guidance conflicted or could not be collected.";
    };
    readonly KERNEL_OUTPUT: {
        readonly exitClass: "failed";
        readonly description: "The bounded response could not be rendered or delivered.";
    };
    readonly KERNEL_RELEASE: {
        readonly exitClass: "failed";
        readonly description: "The application context could not be released.";
    };
};
export type KernelCode = keyof typeof kernelErrors;
/** Serialized UTF-8 JSON limits. Constructors/ingress reject mandatory overflow. */
export declare const protocolLimits: Readonly<{
    readonly defaultOutput: 32768;
    readonly minimumOutput: 8192;
    readonly instruction: 1024;
    readonly reminders: 1024;
    readonly recovery: 1024;
    readonly references: 1024;
    readonly manifest: 2048;
    readonly diagnosticSummary: 512;
}>;
export type FamilyCode<D extends ErrorDefinitions> = (keyof D & string) | KernelCode;
export type Effect = "read" | "write";
export type ExitClass = "failed" | "usage" | "connection" | "version";
export type ExitCode = 0 | 1 | 2 | 3 | 4;
export type ErrorDefinitions = Readonly<Record<string, {
    readonly exitClass: ExitClass;
    readonly description: string;
}>>;
export type Issue = {
    readonly code: string;
    readonly message: string;
    readonly path?: readonly (string | number)[];
};
export type ErrorOptions = {
    readonly message: string;
    /** One sentence explaining the restriction, shown only on refusal. */
    readonly why?: string;
    readonly issues?: readonly Issue[];
    readonly details?: JsonValue;
};
/** Catalog description supplies default why; explicit contextual why overrides it.
 * Doctor is attached centrally. A continuation only supplements that registered read.
 */
export type CliError<Code extends string = string, Class extends ExitClass = ExitClass> = Class extends ExitClass ? Readonly<ErrorOptions & {
    code: Code;
    exitClass: Class;
    readonly continuation?: Invocation<"read">;
    readonly recovery?: never;
}> & Brand<"CliError"> : never;
export interface ErrorCatalog<D extends ErrorDefinitions> {
    readonly definitions: D;
    readonly error: <const K extends keyof D & string>(code: K, options: ErrorOptions & {
        readonly continuation?: Invocation<"read">;
        readonly recovery?: never;
    }) => CliError<K, D[K]["exitClass"]>;
}
/** Secondary failures never change the existing primary code, class or rationale. */
export type SecondaryFailure = {
    readonly code: KernelCode;
    readonly message: string;
};
export type ResponseError<Code extends string = string, Class extends ExitClass = ExitClass> = Class extends ExitClass ? CliError<Code, Class> & {
    readonly why: string;
    readonly secondary: readonly SecondaryFailure[];
} & (Class extends "connection" ? {
    readonly doctor: Invocation<"read">;
} : {
    readonly doctor?: never;
}) : never;
export declare function defineErrors<const D extends ErrorDefinitions>(definitions: D & (string extends keyof D ? never : unknown) & Record<Extract<keyof D, KernelCode>, never>): ErrorCatalog<D>;
/** Private package seam: all kernel failures share the catalog constructor. */
export declare function kernelError<K extends KernelCode>(code: K, options: ErrorOptions): CliError<K, typeof kernelErrors[K]["exitClass"]>;
/** Validate an erased report against its bound catalog before restoring an error brand. */
export declare function checkedError(value: unknown, catalog: ErrorCatalog<ErrorDefinitions>): CliError;
/** Private constructor: execution supplies only a provenance-checked registered path. */
export declare function unknownAcknowledgmentFact(commandPath: string, payloadHash?: Sha256): UnknownAcknowledgment;
type HandlerOnly = {
    readonly reminders?: never;
    readonly payload?: never;
    readonly effect?: never;
    readonly exitCode?: never;
    readonly why?: never;
};
type SuccessShape<Data> = HandlerOnly & HandlerGuidance & {
    readonly ok: true;
    readonly error?: never;
    /** Nonfatal diagnostics only. Error diagnostics belong to CliError. */
    readonly issues?: readonly Issue[];
} & ({
    readonly data: Data;
    readonly binary?: never;
} | {
    readonly binary: AnyBinaryArtifactRequest & {
        readonly summary: Data;
    };
    readonly data?: never;
});
type FailureShape<Data, Code extends string = string> = HandlerOnly & HandlerGuidance & {
    readonly ok: false;
    readonly error: CliError<Code>;
    readonly data?: Data;
    readonly binary?: never;
    readonly issues?: never;
};
type ResultShape<Data, Code extends string = string> = SuccessShape<Data> | FailureShape<Data, Code>;
/** Domain output before arbitration, rendering, or delivery; ordinary DTO interfaces work. */
export type Success<Data> = SuccessShape<JsonData<Data>>;
export type Failure<Data, Code extends string = string> = FailureShape<JsonData<Data>, Code>;
export type Result<Data, Code extends string = string> = ResultShape<JsonData<Data>, Code>;
/** Framework boundaries accept already-checked JSON without recursively remapping JsonValue. */
export type AnySuccess = SuccessShape<JsonValue>;
export type AnyFailure<Code extends string = string> = FailureShape<JsonValue, Code>;
export type AnyResult<Code extends string = string> = ResultShape<JsonValue, Code>;
/** Only execution can stamp preparation, after prepare succeeds for this command. */
export type Prepared<Path extends string, Data> = Brand<"Prepared", Path> & {
    readonly value: Data;
    readonly payloadHash: Sha256;
};
export type Preparation<Data, Code extends string = string> = {
    readonly ok: true;
    readonly value: Data;
    readonly error?: never;
} | (Failure<never, Code> & {
    readonly value?: never;
});
/** Only app-reported identifiers may claim durable recovery; never synthesize an ID. */
export type RecoveryReference = {
    readonly kind: string;
    readonly id: string;
};
export type ReportedRecovery = Brand<"ReportedRecovery"> & {
    readonly kind: "reported";
    readonly references: NonEmpty<RecoveryReference>;
};
/** Validate serialized size <= protocolLimits.recovery before branding. */
export declare function recoveryFacts(references: NonEmpty<RecoveryReference>): ReportedRecovery;
/** Private execution creates this from registered metadata, excluding all raw/secret inputs. */
export type UnknownAcknowledgment = Brand<"UnknownAcknowledgment"> & {
    readonly kind: "unknown_acknowledgment";
    readonly commandPath: string;
    readonly payloadHash?: Sha256;
    readonly advice: "inspect_before_retry";
};
export type CompactRecovery = ReportedRecovery | UnknownAcknowledgment;
/** The sole effect model for application reports, execution and response assembly. */
export type OperationEffect = {
    readonly effect: "read";
    readonly recovery?: never;
} | {
    readonly effect: "not_applied";
    readonly recovery?: never;
} | {
    readonly effect: "applied";
    readonly recovery: ReportedRecovery;
} | {
    readonly effect: "unknown";
    readonly recovery: CompactRecovery;
};
export type SuccessfulEffect = Extract<OperationEffect, {
    readonly effect: "read" | "applied";
}>;
export type WriteEffect = Exclude<OperationEffect, {
    readonly effect: "read";
}>;
/** Application reports facts; only execution establishes invocation provenance. */
type CommitReportShape<Data, Code extends string = string> = {
    [E in WriteEffect["effect"]]: Extract<WriteEffect, {
        readonly effect: E;
    }> & {
        readonly result: E extends "applied" ? ResultShape<Data, Code> : FailureShape<Data, Code>;
    };
}[WriteEffect["effect"]];
export type CommitReport<Data, Code extends string = string> = CommitReportShape<JsonData<Data>, Code>;
export type AnyCommitReport<Code extends string = string> = CommitReportShape<JsonValue, Code>;
/** Outcome correlation reused by execution; failures can retain applied/unknown effects. */
export type OperationOutcome<Code extends string = string> = {
    readonly result: AnySuccess;
    readonly operation: SuccessfulEffect;
} | {
    readonly result: AnyFailure<Code>;
    readonly operation: OperationEffect;
};
type EnvelopeShape<Body> = Brand<"Envelope"> & WireGuidance & {
    readonly why?: never;
} & (({
    readonly ok: true;
    readonly payload: Body;
    readonly issues: readonly Issue[];
    readonly error?: never;
} & SuccessfulEffect) | ({
    readonly ok: false;
    readonly payload?: Body;
    readonly error: ResponseError;
    readonly issues?: never;
} & OperationEffect));
/** Serialized response contract. Only the pipeline can create a valid envelope. */
export type Envelope<Data> = EnvelopeShape<Payload<Data>>;
export type AnyEnvelope = EnvelopeShape<AnyPayload>;
/** Wire admission validates shape and bounds, not registry or filesystem authority. */
export declare function decodeWireEnvelope(value: unknown): AnyEnvelope;
export {};
//# sourceMappingURL=results.d.ts.map