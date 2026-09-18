import type { StandardSchema } from "../input.js";
/** Application modules are the author's own objects; copy their own fields as they are. */
export declare function executableRecord(value: unknown): Record<string, unknown>;
export type LazyPayload = {
    readonly kind: "read" | "write";
    readonly decode: StandardSchema<unknown>;
    readonly handler: Readonly<Record<string, unknown>>;
};
export declare function makePayloadModule(handler: unknown, kind: "read" | "write"): object;
export declare function payloadModule(token: unknown, kind: "read" | "write"): LazyPayload;
type ErasedRunner = (input: unknown) => Promise<unknown>;
export declare function makeRenderedRunner(definition: unknown): ErasedRunner;
export declare function primaryRenderer(run: ErasedRunner, data: import("../values.js").JsonValue | undefined): () => string;
export declare function selectRunner(module: Readonly<Record<string, unknown>>, spec: import("../commands.js").CommandSpec, level?: string): ErasedRunner;
export {};
//# sourceMappingURL=runner-modules.d.ts.map