import type { JsonValue } from "../values.js";
import type { Invocation } from "../commands.js";
export declare function retainJsonIdentity(value: object): void;
export declare function jsonIdentity(value: object): object;
/** Shared boundary checks stay free of host capabilities and package dependencies. */
export declare function assertNonnegativeInteger(value: unknown): asserts value is number;
/** Reject terminal controls and lone surrogates without changing application text. */
export declare function assertText(value: unknown): asserts value is string;
export declare function assertIdentifier(value: unknown): asserts value is string;
/** Shared artifact request/wire syntax; MIME tokens permit bounded parameters. */
export declare function assertMediaType(value: unknown): asserts value is string;
/** Writing and remote decoding admit the same artifact metadata combinations. */
export declare function assertArtifactMetadata({ mediaType, format, reason, contains }: Readonly<Record<string, unknown>>): void;
/** An observation only; constructors must retain a snapshot before checking shape/size. */
export declare function assertJsonValue(value: unknown): asserts value is JsonValue;
export declare function serializedJson(value: unknown): string;
/** Count the actual JSON representation, including quotes, escapes and UTF-8 expansion. */
export declare function assertSerializedLimit(value: unknown, limit: number): void;
/** Capture once before domain/size checks; return the same snapshot after those checks. */
export declare function frozenJson<T>(value: T): T;
export declare function assertRecord(value: unknown): asserts value is Record<string, unknown>;
export declare function assertFields(value: Record<string, unknown>, required: readonly string[], optional?: readonly string[]): void;
/** Shape only: registry/delivery still owns membership, runnable inputs and secret checks. */
export declare function assertInvocation(value: unknown, effect?: "read"): asserts value is Pick<Invocation, "path" | "effects" | "args" | "flags" | "passthrough">;
//# sourceMappingURL=validation.d.ts.map