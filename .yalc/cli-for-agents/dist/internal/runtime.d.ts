import type { Cli, RunRequest, RunResult } from "../runtime/index.js";
/** The public production caller: owners retain parsing, lifetime, arbitration and bounds. */
export declare function runProduction<Contexts>(cli: Cli<Contexts>, request: RunRequest): Promise<RunResult>;
//# sourceMappingURL=runtime.d.ts.map