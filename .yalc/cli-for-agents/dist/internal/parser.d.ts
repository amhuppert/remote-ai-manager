import type { RegistryNode } from "./registry.js";
import type { CheckedInput } from "./input-model.js";
/** json is the production selection. explicitJson is defined only for exactly one
 * syntactically valid --json[=true|false] before --, so a test harness can detect a
 * contradiction without inventing a duplicate flag. */
export type FormatObservation = {
    readonly json: boolean;
    readonly explicitJson: boolean | undefined;
};
export type TokenResolution = FormatObservation & ({
    readonly kind: "offline";
    readonly route: "help" | "version" | "exit-codes";
    readonly path: string;
} | {
    readonly kind: "leaf";
    readonly node: RegistryNode;
    readonly input: CheckedInput;
});
/** Globals may surround route tokens; command-specific flags follow the leaf.
 * Retain format before reporting any refusal. Keep scanning after lexical errors
 * so option ordering cannot change error representation; never scan past --. */
export declare function parseTokens(nodes: Readonly<Record<string, RegistryNode>>, argv: readonly string[], retainFormat?: (format: FormatObservation) => void): TokenResolution;
//# sourceMappingURL=parser.d.ts.map