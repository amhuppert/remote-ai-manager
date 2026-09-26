import type { Cli, RunRequest, RunResult } from "../runtime/index.js";
/** The public production caller: owners retain parsing, lifetime, arbitration and bounds.
 * A selected format changes only the final representation, never parsing or execution. */
export declare function runProduction<Contexts>(cli: Cli<Contexts>, request: RunRequest, selection?: {
    readonly format?: "text" | "json";
}): Promise<RunResult>;
//# sourceMappingURL=runtime.d.ts.map