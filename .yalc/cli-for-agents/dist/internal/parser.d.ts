import type { RegistryNode } from "./registry.js";
import type { CheckedInput } from "./input-model.js";
export type TokenResolution = {
    readonly kind: "offline";
    readonly route: "help" | "version" | "exit-codes";
    readonly path: string;
    readonly json: boolean;
} | {
    readonly kind: "leaf";
    readonly node: RegistryNode;
    readonly input: CheckedInput;
    readonly json: boolean;
};
/** Globals may surround route tokens; command-specific flags follow the leaf.
 * Retain format before reporting any refusal. Keep scanning after lexical errors
 * so option ordering cannot change error representation; never scan past --. */
export declare function parseTokens(nodes: Readonly<Record<string, RegistryNode>>, argv: readonly string[], retainFormat?: (json: boolean) => void): TokenResolution;
//# sourceMappingURL=parser.d.ts.map