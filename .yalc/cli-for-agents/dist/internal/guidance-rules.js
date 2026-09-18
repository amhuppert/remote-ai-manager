import { protocolLimits } from "../results.js";
import { commandData } from "./declarations.js";
import { assertFields, assertIdentifier, assertRecord, assertSerializedLimit, assertText, frozenJson } from "./validation.js";
/** Callback-bearing declarations are copied field by field; JSON cloning would drop
 * the callbacks and the command identities they reference. */
export function captureRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new TypeError("Expected a rule/evaluation record.");
    return { ...value };
}
export function captureArray(value) {
    if (!Array.isArray(value))
        throw new TypeError("Expected a plain array.");
    return Object.freeze([...value]);
}
export function checkGuidanceId(value) {
    assertIdentifier(value);
    assertSerializedLimit(value, protocolLimits.diagnosticSummary);
}
export function checkEvidence(value) {
    assertText(value);
    assertSerializedLimit(value, protocolLimits.diagnosticSummary);
}
export function checkPriority(value) {
    if (typeof value !== "number" || !Number.isFinite(value))
        throw new TypeError("Expected a finite priority.");
}
function checkCallback(value) {
    if (typeof value !== "function" || Object.prototype.toString.call(value) !== "[object Function]") {
        throw new TypeError("Rule callbacks must be synchronous functions.");
    }
}
function admit(definition, reminder) {
    const snapshot = captureRecord(definition);
    assertFields(snapshot, reminder ? ["id", "appliesTo", "when", "priority", "text"] : ["id", "appliesTo", "when", "tier", "render"], reminder ? ["evidence"] : []);
    checkGuidanceId(snapshot["id"]);
    checkCallback(snapshot["when"]);
    const appliesTo = captureArray(snapshot["appliesTo"]);
    if (appliesTo.length === 0 || new Set(appliesTo).size !== appliesTo.length)
        throw new TypeError("Expected nonempty unique rule command references.");
    let family;
    for (const command of appliesTo) {
        if (command === null || typeof command !== "object")
            throw new TypeError("Expected a command token.");
        const data = commandData(command);
        if (family !== undefined && family !== data.family)
            throw new TypeError("Rule commands must share a family.");
        family = data.family;
    }
    if (reminder) {
        checkPriority(snapshot["priority"]);
        checkCallback(snapshot["text"]);
        if (Object.hasOwn(snapshot, "evidence"))
            checkEvidence(snapshot["evidence"]);
    }
    else {
        if (snapshot["tier"] !== "hint" && snapshot["tier"] !== "instruction")
            throw new TypeError("Unsupported steering tier.");
        checkCallback(snapshot["render"]);
    }
    // Retained command identities and callbacks are not cloned.
    return Object.freeze({ ...snapshot, appliesTo, ...(reminder ? { tier: "reminder" } : {}) });
}
export function makeReminderRule(definition) {
    return admit(definition, true);
}
export function makeSteering(definition) {
    return admit(definition, false);
}
/** Rules come from defineReminderRule/defineSteering; a raw definition fails here clearly. */
export function checkRule(value) {
    if (value === null || typeof value !== "object" || !("id" in value) || !("appliesTo" in value)
        || !("when" in value) || !("tier" in value))
        throw new TypeError("Expected an admitted guidance rule.");
}
/** The provider returns what evaluateGuidance produced; a wrong return fails here clearly. */
export function checkEvaluatedGuidance(value) {
    const snapshot = frozenJson(value);
    assertRecord(snapshot);
    assertFields(snapshot, ["commandPath", "candidates", "firings", "issues"]);
    assertText(snapshot["commandPath"]);
    const candidates = snapshot["candidates"];
    if (!Array.isArray(candidates) || !Array.isArray(snapshot["firings"]) || !Array.isArray(snapshot["issues"]))
        throw new TypeError("Expected guidance batch arrays.");
    for (const entry of candidates) {
        assertRecord(entry);
        if (!["hint", "instruction", "reminder"].includes(entry["tier"]))
            throw new TypeError("Unsupported guidance tier.");
        assertRecord(entry["value"]);
        const provenance = entry["provenance"];
        assertRecord(provenance);
        checkGuidanceId(provenance["ruleId"]);
    }
    return snapshot;
}
//# sourceMappingURL=guidance-rules.js.map