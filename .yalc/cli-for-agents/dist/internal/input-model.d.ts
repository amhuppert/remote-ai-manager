import type { CommandSpec } from "../commands.js";
import type { Flag } from "../input.js";
import type { HelpFlag } from "../runtime/index.js";
import { type Issue } from "../results.js";
import type { Bytes } from "../values.js";
export declare const frameworkFlags: Readonly<{
    readonly help: "boolean";
    readonly json: "boolean";
    readonly version: "boolean";
    readonly out: "value";
    readonly file: "value";
}>;
/** Retains input identity across the synchronous parser's refusal boundary. */
export declare class InputValidationError extends TypeError {
    readonly issue: Issue;
    constructor(label: string, path: readonly string[], message?: string);
}
export declare function checkName(name: string): void;
export declare function checkPath(path: string): void;
export declare function scalar(value: HelpFlag["value"], input: unknown): string | number | boolean;
/** Diagnostics describe declarations, never caller values (which may be secrets). */
export declare function invalidInput(value: HelpFlag["value"], label: string, path: readonly string[]): InputValidationError;
export declare function checkFlags(flags: Readonly<Record<string, Flag>>): void;
type ModelFlag = Omit<Flag, "value"> & {
    readonly value: HelpFlag["value"];
};
export type FlagEntry = {
    readonly help: HelpFlag;
    readonly definition: ModelFlag;
    readonly target: string;
    readonly global: boolean;
};
export type InputModel = {
    readonly spec: CommandSpec;
    readonly flags: Readonly<Record<string, FlagEntry>>;
    readonly selectors: Readonly<Record<string, readonly string[]>>;
};
/** One inventory supplies parser tokens, help descriptors and invocation checks. */
export declare function inputModel(spec: CommandSpec, globals: Readonly<Record<string, Flag>>): InputModel;
export type InputSource = {
    readonly kind: "argument" | "flag" | "global" | "payload";
    readonly name: string;
    readonly path: string;
    readonly maxBytes: Bytes;
};
export type CheckedInput = {
    readonly args: Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>;
    readonly flags: Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>;
    readonly globals: Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>;
    readonly sources: readonly InputSource[];
    readonly credentials: readonly {
        readonly name: string;
        readonly env: string;
        readonly global: boolean;
        readonly required: boolean;
    }[];
    readonly file?: string;
    readonly level?: string;
    readonly out?: string;
    readonly passthrough?: readonly string[];
};
/** Checks caller/example records without reading a selected source or environment. */
export declare function checkCaller(model: InputModel, caller: object, suggestion: boolean): CheckedInput;
export {};
//# sourceMappingURL=input-model.d.ts.map