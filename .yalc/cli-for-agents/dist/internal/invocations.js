import { commandData } from "./declarations.js";
import { checkCaller } from "./input-model.js";
import { assertInvocation, assertText, frozenJson, jsonIdentity, retainJsonIdentity } from "./validation.js";
const references = new WeakMap();
export function invocationTarget(reference) {
    const target = references.get(jsonIdentity(reference));
    if (!target)
        throw new TypeError("Unknown or forged invocation token.");
    return target;
}
/** This boundary is also used for createCli's mandatory runnable doctor. */
export function makeInvocation(command, input, validation) {
    const data = commandData(command);
    const spec = data.model.spec;
    if (validation && (spec.effects !== "write" || !spec.payload))
        throw new TypeError("Command has no validation twin.");
    const caller = frozenJson(input);
    const checked = checkCaller(data.model, caller, true);
    const flags = { ...caller.flags };
    if (checked.file !== undefined)
        flags["file"] = checked.file;
    if (checked.out !== undefined)
        flags["out"] = checked.out;
    if (checked.level !== undefined)
        for (const selector of data.model.selectors[checked.level])
            flags[selector] = true;
    const args = [];
    const suppliedArgs = caller.args ?? {};
    let omitted = false;
    for (const arg of spec.args) {
        const value = Object.hasOwn(checked.args, arg.name) ? checked.args[arg.name] : undefined;
        if (value === undefined || Array.isArray(value) && value.length === 0) {
            omitted = true;
            continue;
        }
        if (omitted) {
            if (Object.hasOwn(suppliedArgs, arg.name))
                throw new TypeError("Cannot supply a positional after an omitted positional.");
            // Leave later defaults omitted so parsing assigns them to their own names.
            continue;
        }
        args.push(...(Array.isArray(value) ? value : [value]).map(String));
    }
    checkPositionalTokens(args, spec.passthrough === true);
    const value = frozenJson({ path: validation && spec.effects === "write" && spec.payload ? spec.payload.validatePath : spec.path,
        effects: validation ? "read" : spec.effects, args, flags,
        ...(checked.passthrough !== undefined ? { passthrough: checked.passthrough } : {}) });
    assertInvocation(value);
    const reference = value;
    references.set(reference, Object.freeze({ command, validation }));
    retainJsonIdentity(reference);
    return reference;
}
const registeredCommands = new WeakSet();
/** Called only after the complete graph has passed register's checks. */
export function markRegistered(command) {
    commandData(command);
    registeredCommands.add(command);
}
/** argv construction and shell rendering share exactly these token boundaries. */
export function invocationArgv(reference) {
    const { command } = invocationTarget(reference);
    return referenceTokens(reference, commandData(command).model.spec.passthrough === true);
}
/** Also used after detached reference shape validation at the registry boundary. */
export function referenceTokens(reference, passthrough) {
    checkPositionalTokens(reference.args, passthrough);
    const tokens = reference.path.split(" ");
    for (const [name, value] of Object.entries(reference.flags)) {
        for (const item of Array.isArray(value) ? value : [value])
            tokens.push(item === true ? `--${name}` : `--${name}=${String(item)}`);
    }
    if (reference.args.length) {
        if (!passthrough)
            tokens.push("--");
        tokens.push(...reference.args);
    }
    if (reference.passthrough?.length)
        tokens.push("--", ...reference.passthrough);
    return Object.freeze(tokens);
}
export function renderReference(reference, executable) {
    const target = invocationTarget(reference);
    if (!registeredCommands.has(target.command))
        throw new TypeError("Invocation target is not registered.");
    return renderTokens(invocationArgv(reference), executable);
}
/** Shape-checked detached references; current-registry rebinding is caller-owned. */
export function renderDetachedReference(reference, executable) {
    assertInvocation(reference);
    return renderTokens(referenceTokens(reference, reference.passthrough !== undefined), executable);
}
function renderTokens(tokens, executable) {
    assertText(executable);
    const quote = (token, force = false) => !force && /^[a-zA-Z0-9_@%+=:,./-]+$/.test(token) ? token : `'${token.replaceAll("'", "'\\''")}'`;
    // Brand only the result assembled from individually quoted, checked tokens.
    const reserved = ["if", "then", "else", "elif", "fi", "do", "done", "case", "esac", "while", "until", "for", "in", "time", "function", "select", "coproc"];
    return [quote(executable, executable.includes("=") || reserved.includes(executable)),
        ...tokens.map(token => quote(token))].join(" ");
}
export function hasInvocationProvenance(value) { return references.has(jsonIdentity(value)); }
/** Protect the positional/passthrough boundary before tokens enter the parser. */
function checkPositionalTokens(args, passthrough) {
    if (passthrough && args.some(token => token.startsWith("-") && token !== "-" && !/^-[0-9]+$/.test(token))) {
        throw new TypeError("Leading-dash positional cannot be rendered with passthrough enabled.");
    }
}
//# sourceMappingURL=invocations.js.map