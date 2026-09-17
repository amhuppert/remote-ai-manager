import { checkedSha256 } from "../values.js";
import { commandData } from "./declarations.js";
const scopes = new WeakMap();
const preparations = new WeakMap();
/** Execution creates one scope per run; neither the scope nor its mint is public. */
export function preparationScope(command, hash) {
    const data = commandData(command);
    if (data.model.spec.effects !== "write" || !data.model.spec.payload)
        throw new TypeError("Preparation requires a payload mutation.");
    const scope = Object.freeze({});
    scopes.set(scope, { command, hash: checkedSha256(hash) });
    return scope;
}
export function mintPreparation(scope, value) {
    const identity = scopes.get(scope);
    if (!identity)
        throw new TypeError("Unknown preparation scope.");
    const token = Object.freeze({ value, payloadHash: identity.hash });
    preparations.set(token, { ...identity, scope, consumed: false });
    return token;
}
/** Validate all provenance and consume before calling application commit, even if it throws. */
export async function usePreparation(scope, token, hash, commit) {
    const identity = scopes.get(scope);
    const prepared = preparations.get(token);
    if (!identity || !prepared || prepared.scope !== scope || prepared.command !== identity.command
        || prepared.hash !== identity.hash || hash !== prepared.hash || token.payloadHash !== prepared.hash || prepared.consumed) {
        throw new TypeError("Invalid or consumed preparation provenance.");
    }
    prepared.consumed = true;
    return commit(token);
}
//# sourceMappingURL=preparations.js.map