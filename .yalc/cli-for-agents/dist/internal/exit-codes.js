import { frozenJson } from "./validation.js";
/** Shared numeric taxonomy for offline references and response composition. */
export const exitTaxonomy = frozenJson([
    { code: 0, exitClass: "success", description: "The command completed successfully." },
    { code: 1, exitClass: "failed", description: "The operation failed." },
    { code: 2, exitClass: "usage", description: "Correct local arguments or input before retrying." },
    { code: 3, exitClass: "connection", description: "Diagnose connection or context acquisition with the registered doctor." },
    { code: 4, exitClass: "version", description: "Resolve version incompatibility before retrying." },
]);
export function exitCodeForClass(exitClass) {
    const entry = exitTaxonomy.find(entry => entry.exitClass === exitClass);
    if (!entry)
        throw new TypeError("Unknown exit class.");
    return entry.code;
}
//# sourceMappingURL=exit-codes.js.map