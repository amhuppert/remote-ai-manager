import { checkedError, kernelError, recoveryFacts } from "../results.js";
import { hint, instruction } from "../guidance/index.js";
import { checkBinaryRequest } from "./binary.js";
import { executableRecord } from "./runner-modules.js";
import { assertFields, assertRecord, frozenJson } from "./validation.js";
export function checkedResult(value, errors, binary) {
    const raw = executableRecord(value);
    let binaryRequest;
    if (Object.hasOwn(raw, "binary")) {
        if (!binary)
            throw new TypeError("Undeclared binary output.");
        const request = raw["binary"];
        checkBinaryRequest(request);
        binaryRequest = request;
        delete raw["binary"];
    }
    const result = frozenJson(raw);
    assertRecord(result);
    if (result["ok"] === true) {
        assertFields(result, ["ok", ...(binaryRequest ? [] : ["data"])], ["issues", "hint", "instruction"]);
        if (Object.hasOwn(result, "issues"))
            kernelError("KERNEL_CONTRACT", { message: "Validate diagnostics.", issues: result["issues"] });
    }
    else if (result["ok"] === false && !binaryRequest) {
        assertFields(result, ["ok", "error"], ["data", "hint", "instruction"]);
    }
    else
        throw new TypeError("Invalid result discriminant.");
    if (Object.hasOwn(result, "hint") && Object.hasOwn(result, "instruction"))
        throw new TypeError("Conflicting handler guidance.");
    const guidance = {};
    if (Object.hasOwn(result, "hint")) {
        const value = result["hint"];
        assertRecord(value);
        assertFields(value, ["invocation", "action"]);
        guidance.hint = hint(value["invocation"], value["action"]);
    }
    if (Object.hasOwn(result, "instruction")) {
        const value = result["instruction"];
        assertRecord(value);
        assertFields(value, ["ownerId", "text"]);
        guidance.instruction = instruction(value["ownerId"], value["text"]);
    }
    const checked = { ...result, ...guidance, ...(binaryRequest ? { binary: binaryRequest } : {}),
        ...(result["ok"] === false ? { error: checkedError(result["error"], errors) } : {}) };
    // Exact result/effect and JSON checks above establish the erased report boundary.
    return Object.freeze(checked);
}
function reported(value) {
    const checked = frozenJson(value);
    assertRecord(checked);
    assertFields(checked, ["kind", "references"]);
    if (checked["kind"] !== "reported")
        throw new TypeError("Expected app-reported recovery.");
    return recoveryFacts(checked["references"]);
}
/** Observe independently of result validation so malformed post-write data cannot erase facts. */
export function observeWrite(value, fallback) {
    try {
        if (value["effect"] === "not_applied" && !Object.hasOwn(value, "recovery"))
            return Object.freeze({ effect: "not_applied" });
        if (value["effect"] === "applied")
            return Object.freeze({ effect: "applied", recovery: reported(value["recovery"]) });
        if (value["effect"] === "unknown") {
            // Applications report known IDs; unknown-acknowledgment provenance is runtime-owned.
            return Object.freeze({ effect: "unknown", recovery: reported(value["recovery"]) });
        }
    }
    catch { /* An invalid report cannot establish more certainty than the fallback. */ }
    return fallback;
}
export function checkedWrite(value, operation, errors, binary) {
    assertFields(value, ["effect", "result"], value["effect"] === "not_applied" ? [] : ["recovery"]);
    if (value["effect"] !== operation.effect || operation.effect === "read"
        || operation.effect !== "not_applied" && operation.recovery.kind !== "reported")
        throw new TypeError("Invalid write effect.");
    const result = checkedResult(value["result"], errors, binary);
    if (result.ok && operation.effect !== "applied")
        throw new TypeError("Unapplied writes cannot succeed.");
    return result;
}
/** Preparation values may be opaque app objects; refusals use normal checked error/guidance fields. */
export function checkedPreparation(value, errors) {
    const prepared = executableRecord(value);
    if (prepared["ok"] === true) {
        assertFields(prepared, ["ok", "value"]);
        return { ok: true, value: prepared["value"] };
    }
    if (prepared["ok"] === false) {
        assertFields(prepared, ["ok", "error"], ["hint", "instruction"]);
        const result = checkedResult(prepared, errors, false);
        if (result.ok)
            throw new TypeError("Expected a preparation refusal.");
        if (result.instruction)
            return { ok: false, error: result.error, instruction: result.instruction };
        return { ok: false, error: result.error, ...(result.hint ? { hint: result.hint } : {}) };
    }
    throw new TypeError("Invalid preparation result.");
}
//# sourceMappingURL=execution-reports.js.map