import type { ParsedInvocation } from "./registry.js";
import type { InputFileSource, ResolvedRunRequest } from "../runtime/index.js";
import type { CheckedInput } from "./input-model.js";
import type { Issue, KernelCode } from "../results.js";
import type { LazyPayload } from "./runner-modules.js";
import type { Sha256 } from "../values.js";
import type { Flag } from "../input.js";
export type LocalInput = {
    readonly args: CheckedInput["args"];
    readonly flags: CheckedInput["flags"];
    readonly globals: CheckedInput["globals"];
    readonly inputFiles: readonly InputFileSource[];
    readonly payload?: unknown;
    readonly payloadHash?: Sha256;
    readonly module: Readonly<Record<string, unknown>>;
    readonly decoder?: LazyPayload;
};
export type LocalResolution = {
    readonly ok: true;
    readonly input: LocalInput;
} | {
    readonly ok: false;
    readonly code: KernelCode;
    readonly issues?: readonly Issue[];
};
export declare function resolveLocalInput<Contexts, Code extends string, G extends Readonly<Record<string, Flag>>>(invocation: ParsedInvocation<Contexts, Code, G>, request: ResolvedRunRequest): Promise<LocalResolution>;
//# sourceMappingURL=local-input.d.ts.map