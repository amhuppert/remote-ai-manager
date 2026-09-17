import { makeFamily, makeGroup, makeFlow } from "./internal/declarations.js";
import { makePayloadModule, makeRenderedRunner } from "./internal/runner-modules.js";
import { makeInvocation } from "./internal/invocations.js";
/** A renderer is retained privately by its checked runner; only JSON data reaches it.
 * Runtime validates results before calling text, and owns the structural default.
 */
export function runner(_definition) { return makeRenderedRunner(_definition); }
export function writeRunner(_definition) { return makeRenderedRunner(_definition); }
export function payloadRead(_handler) { return makePayloadModule(_handler, "read"); }
export function mutation(_handler) { return makePayloadModule(_handler, "write"); }
export function commandsFor() {
    return (options) => makeFamily(options);
}
export function defineGroup(definition) { return makeGroup(definition); }
/** Suggestions use a real declaration token and cannot include secret or undeclared flags. */
export function invocation(_command, _input) { return makeInvocation(_command, _input, false); }
/** The derived validation route accepts the same file and options but cannot commit. */
export function validationInvocation(_command, _input) { return makeInvocation(_command, _input, true); }
export function defineFlow(_definition) { return makeFlow(_definition); }
//# sourceMappingURL=commands.js.map