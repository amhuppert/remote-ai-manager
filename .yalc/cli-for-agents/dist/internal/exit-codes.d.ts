import type { ExitClass, ExitCode } from "../results.js";
/** Shared numeric taxonomy for offline references and response composition. */
export declare const exitTaxonomy: readonly [{
    readonly code: 0;
    readonly exitClass: "success";
    readonly description: "The command completed successfully.";
}, {
    readonly code: 1;
    readonly exitClass: "failed";
    readonly description: "The operation failed.";
}, {
    readonly code: 2;
    readonly exitClass: "usage";
    readonly description: "Correct local arguments or input before retrying.";
}, {
    readonly code: 3;
    readonly exitClass: "connection";
    readonly description: "Diagnose connection or context acquisition with the registered doctor.";
}, {
    readonly code: 4;
    readonly exitClass: "version";
    readonly description: "Resolve version incompatibility before retrying.";
}];
export declare function exitCodeForClass(exitClass: ExitClass): ExitCode;
//# sourceMappingURL=exit-codes.d.ts.map