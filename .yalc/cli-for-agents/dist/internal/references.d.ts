import type { Cli, ReferenceHost, ReferenceOptions, ReferenceValidation } from "../runtime/index.js";
export declare function referenceHost(options: ReferenceOptions): Promise<ReferenceHost>;
export declare function checkReferences<Contexts>(cli: Cli<Contexts>, options: ReferenceOptions): Promise<ReferenceValidation>;
/** Only the selected, unique whole-line marker pair is replaceable. */
export declare function replaceMarker(document: string, marker: string, generated: string): string;
export declare function writeReference<Contexts>(cli: Cli<Contexts>, options: ReferenceOptions & {
    readonly path: string;
    readonly marker: string;
    readonly mode: "write" | "check";
}): Promise<ReferenceValidation & {
    readonly changed: boolean;
}>;
//# sourceMappingURL=references.d.ts.map