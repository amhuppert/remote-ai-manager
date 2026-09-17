import type { Cli } from "../runtime/index.js";
/** Only this process boundary owns streams and exit; application execution is never retried. */
export declare function runMain<Contexts>(cli: Cli<Contexts>, options?: {
    readonly compileCache?: boolean;
}): Promise<never>;
//# sourceMappingURL=process.d.ts.map