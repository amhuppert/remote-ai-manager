import { protocolLimits } from "../results.js";
import { commandData } from "./declarations.js";
import { assertFields, assertIdentifier, assertSerializedLimit, assertText } from "./validation.js";
const rules = new WeakSet();
/** Callback-bearing declarations need descriptor capture without JSON cloning identities. */
export function captureRecord(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value))
        throw new TypeError("Expected a rule/evaluation record.");
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null)
        throw new TypeError("Expected a plain record.");
    const copy = Object.create(null);
    for (const key of Reflect.ownKeys(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) {
            throw new TypeError("Expected enumerable data properties.");
        }
        copy[key] = descriptor.value;
    }
    return copy;
}
export function captureArray(value) {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
        throw new TypeError("Expected a plain array.");
    const length = Object.getOwnPropertyDescriptor(value, "length")?.value;
    const keys = Reflect.ownKeys(value);
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) {
        throw new TypeError("Expected a dense undecorated array.");
    }
    const copy = [];
    for (let i = 0; i < length; i++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
        if (!descriptor?.enumerable || !("value" in descriptor))
            throw new TypeError("Expected array data elements.");
        copy.push(descriptor.value);
    }
    return Object.freeze(copy);
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
    // Brands follow complete admission; retained command identities and callbacks are not cloned.
    const rule = Object.freeze({ ...snapshot, appliesTo, ...(reminder ? { tier: "reminder" } : {}) });
    rules.add(rule);
    return rule;
}
export function makeReminderRule(definition) {
    return admit(definition, true);
}
export function makeSteering(definition) {
    return admit(definition, false);
}
export function checkRule(value) {
    if (value === null || typeof value !== "object" || !rules.has(value))
        throw new TypeError("Unknown or forged guidance rule.");
}
// Preserve local rule identities across evaluation/decoding until composition can
// check the current CLI. Authoritative wire batches have no local declarations.
const evaluationReferences = new WeakMap();
export function retainEvaluationRules(batch, rules) {
    evaluationReferences.set(batch, Object.freeze([...rules]));
}
export function evaluatedRules(batch) {
    return batch !== null && typeof batch === "object" ? evaluationReferences.get(batch) ?? [] : [];
}
//# sourceMappingURL=guidance-rules.js.map