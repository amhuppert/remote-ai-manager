import type { Command, Invocation } from "../commands.js";
export declare function invocationTarget(reference: object): {
    readonly command: object;
    readonly validation: boolean;
};
/** This boundary is also used for createCli's mandatory runnable doctor. */
export declare function makeInvocation(command: Pick<Command, "spec" | "globalFlags">, input: object, validation: boolean): Invocation;
/** Called only after the complete graph has passed register's checks. */
export declare function markRegistered(command: object): void;
/** argv construction and shell rendering share exactly these token boundaries. */
export declare function invocationArgv(reference: Invocation): readonly string[];
/** Also used after detached reference shape validation at the registry boundary. */
export declare function referenceTokens(reference: Pick<Invocation, "path" | "args" | "flags" | "passthrough">, passthrough: boolean): readonly string[];
export declare function renderReference(reference: Invocation, executable: string): import("../values.js").ShellSafe;
/** Shape-checked detached references; current-registry rebinding is caller-owned. */
export declare function renderDetachedReference(reference: Invocation, executable: string): string;
export declare function hasInvocationProvenance(value: object): boolean;
//# sourceMappingURL=invocations.d.ts.map