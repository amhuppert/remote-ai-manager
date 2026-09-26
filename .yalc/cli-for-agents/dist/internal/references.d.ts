import type { Cli, ReferenceHost, ReferenceOptions, ReferenceValidation, ReferenceWriteResult } from "../runtime/index.js";
export declare function referenceHost(options: ReferenceOptions): Promise<ReferenceHost>;
export declare function checkReferences<Contexts>(cli: Cli<Contexts>, options: ReferenceOptions): Promise<ReferenceValidation>;
/** Only the selected, unique whole-line marker pair is replaceable. The block is the
 * inserted text after newline normalization, excluding the marker lines. */
export declare function replaceMarker(document: string, marker: string, generated: string): {
    readonly document: string;
    readonly block: string;
};
export declare function writeReference<Contexts>(cli: Cli<Contexts>, options: ReferenceOptions & {
    readonly path: string;
    readonly marker: string;
    readonly mode: "write" | "check";
}): Promise<ReferenceWriteResult>;
//# sourceMappingURL=references.d.ts.map