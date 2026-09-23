import { protocolLimits } from "../results.js";
import { bytes, id } from "../values.js";
import { assertFields, assertIdentifier, assertRecord, assertText, frozenJson } from "./validation.js";
export const frameworkFlags = Object.freeze({ help: "boolean", json: "boolean", version: "boolean", out: "value", file: "value" });
/** Retains input identity across the synchronous parser's refusal boundary. */
export class InputValidationError extends TypeError {
    issue;
    constructor(label, path, message = `Missing required ${label}.`) {
        super(message);
        this.issue = Object.freeze({ code: "invalid_value", message: this.message, path: Object.freeze([...path]) });
    }
}
export function checkName(name) {
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(name))
        throw new TypeError("Invalid name spelling.");
}
export function checkPath(path) {
    assertText(path);
    for (const token of path.split(" "))
        checkName(token);
    if (["help", "version", "exit-codes"].includes(path.split(" ")[0]))
        throw new TypeError("Reserved command route.");
}
export function scalar(value, input) {
    switch (value.kind) {
        case "boolean":
            if (typeof input === "boolean")
                return input;
            break;
        case "integer":
            if (typeof input === "number" && Number.isSafeInteger(input)
                && (value.min === undefined || input >= value.min) && (value.max === undefined || input <= value.max))
                return Object.is(input, -0) ? 0 : input;
            break;
        case "string":
            if (typeof input === "string" && (value.minLength === undefined || input.length >= value.minLength)
                && (value.maxLength === undefined || input.length <= value.maxLength))
                return input;
            break;
        case "enum":
            if (typeof input === "string" && value.values.includes(input))
                return input;
            break;
        case "pattern":
            if (typeof input === "string" && new RegExp(value.pattern, "u").test(input))
                return input;
            break;
        case "url":
            if (typeof input === "string") {
                try {
                    new URL(input);
                    return input;
                }
                catch { /* refusal below */ }
            }
            break;
        case "id":
            if (typeof input === "string")
                return id(value.domain, input);
            break;
        case "output-path":
        case "file":
            if (typeof input === "string" && input.length > 0 && !input.includes("\0"))
                return input;
            break;
    }
    throw new TypeError("Input does not match its declared value kind or bounds.");
}
/** Diagnostics describe declarations, never caller values (which may be secrets). */
export function invalidInput(value, label, path) {
    let expected;
    switch (value.kind) {
        case "integer":
            expected = `a safe integer${value.min === undefined ? "" : ` >= ${value.min}`}${value.max === undefined ? "" : ` <= ${value.max}`}`;
            break;
        case "string":
            expected = `text${value.minLength === undefined ? "" : ` with length >= ${value.minLength}`}${value.maxLength === undefined ? "" : ` with length <= ${value.maxLength}`}`;
            break;
        case "enum":
            expected = `one of ${value.values.map(item => JSON.stringify(item)).join(", ")}`;
            break;
        case "pattern":
            expected = value.description;
            break;
        case "boolean":
            expected = "true or false";
            break;
        case "url":
            expected = "an absolute URL";
            break;
        case "id":
            expected = `a valid ${value.domain} identifier`;
            break;
        case "file":
        case "output-path":
            expected = "a nonempty file path";
            break;
    }
    const fits = (text) => new TextEncoder().encode(JSON.stringify(text)).byteLength <= protocolLimits.diagnosticSummary;
    let message = `Invalid ${label}; expected ${expected}.`;
    if (!fits(message))
        message = `Invalid ${label}; see --help for the accepted ${value.kind} values.`;
    if (!fits(message))
        message = "Invalid input; see its issue path and --help for the accepted values.";
    return new InputValidationError(label, path, message);
}
function callerValue(value, input, label, path) {
    try {
        return scalar(value, input);
    }
    catch (error) {
        if (!(error instanceof TypeError))
            throw error;
        throw invalidInput(value, label, path);
    }
}
function checkValue(value) {
    assertRecord(value);
    const fields = { boolean: [], string: ["minLength", "maxLength"], integer: ["min", "max"], enum: ["values"], pattern: ["pattern", "description"], url: [], file: ["maxBytes"], id: ["domain"] };
    if (!Object.hasOwn(fields, value.kind))
        throw new TypeError("Unknown value kind.");
    assertFields(value, ["kind"], fields[value.kind]);
    switch (value.kind) {
        case "string":
            for (const n of [value.minLength, value.maxLength])
                if (n !== undefined)
                    bytes(n);
            if ((value.minLength ?? 0) > (value.maxLength ?? Infinity))
                throw new TypeError("Invalid string bounds.");
            break;
        case "integer":
            for (const n of [value.min, value.max])
                if (n !== undefined && !Number.isSafeInteger(n))
                    throw new TypeError("Invalid integer bounds.");
            if ((value.min ?? -Infinity) > (value.max ?? Infinity))
                throw new TypeError("Invalid integer bounds.");
            break;
        case "enum":
            if (!Array.isArray(value.values) || !value.values.length || new Set(value.values).size !== value.values.length)
                throw new TypeError("Expected a nonempty unique enum inventory.");
            for (const item of value.values)
                assertText(item);
            break;
        case "pattern":
            assertText(value.description);
            if (typeof value.pattern !== "string")
                throw new TypeError("Invalid pattern.");
            try {
                new RegExp(value.pattern, "u");
            }
            catch {
                throw new TypeError("Invalid pattern.");
            }
            break;
        case "file":
            bytes(value.maxBytes);
            break;
        case "id":
            assertIdentifier(value.domain);
            break;
    }
}
function checkInput(input, positional) {
    assertRecord(input);
    assertFields(input, positional ? ["name", "description", "value"] : ["description", "value"], positional
        ? ["required", "default", "variadic"] : ["required", "default", "repeatable", "secret", "credential", "fileSource"]);
    assertText(input.description);
    checkValue(input.value);
    if (input.required !== undefined && typeof input.required !== "boolean")
        throw new TypeError("Invalid required marker.");
    const f = input;
    const a = input;
    for (const marker of [f.repeatable, f.secret, a.variadic])
        if (marker !== undefined && marker !== true)
            throw new TypeError("Invalid input marker.");
    const many = f.repeatable || a.variadic;
    if (positional && input.value.kind === "boolean" || many && ["boolean", "file"].includes(input.value.kind))
        throw new TypeError("Invalid repeated/positional value kind.");
    if (f.fileSource !== undefined) {
        assertRecord(f.fileSource);
        assertFields(f.fileSource, ["maxBytes"]);
        bytes(f.fileSource.maxBytes);
        if (input.value.kind !== "string" || many || f.secret)
            throw new TypeError("Invalid derived file source.");
    }
    if (f.credential !== undefined) {
        assertRecord(f.credential);
        assertFields(f.credential, ["env"]);
        if (typeof f.credential.env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(f.credential.env)
            || !f.secret || input.value.kind !== "string" || many || f.fileSource)
            throw new TypeError("Invalid credential fallback.");
    }
    if (Object.hasOwn(input, "default")) {
        if (input.required === true || many || input.value.kind === "file" || f.secret || f.fileSource)
            throw new TypeError("Invalid default combination.");
        scalar(input.value, input.default);
    }
}
export function checkFlags(flags) {
    assertRecord(flags);
    const used = new Set();
    for (const [name, flag] of Object.entries(flags)) {
        checkName(name);
        checkInput(flag, false);
        for (const key of [name, ...(flag.fileSource ? [`${name}-file`] : [])]) {
            if (Object.hasOwn(frameworkFlags, key) || used.has(key))
                throw new TypeError("Reserved flag or generated name collision.");
            used.add(key);
        }
    }
}
/** One inventory supplies parser tokens, help descriptors and invocation checks. */
export function inputModel(spec, globals) {
    checkFlags(spec.flags);
    checkFlags(globals);
    if (!Array.isArray(spec.args))
        throw new TypeError("Expected finite argument inventory.");
    const names = new Set();
    let optional = false;
    spec.args.forEach((arg, index) => {
        checkInput(arg, true);
        checkName(arg.name);
        if (names.has(arg.name))
            throw new TypeError("Duplicate argument name.");
        names.add(arg.name);
        const required = arg.required !== false && arg.default === undefined;
        if (optional && required)
            throw new TypeError("Required argument follows optional argument.");
        optional ||= !required;
        if (arg.variadic && index !== spec.args.length - 1)
            throw new TypeError("Variadic must be final.");
    });
    const entries = Object.create(null);
    const add = (name, definition, source, target = name, global = false) => {
        if (Object.hasOwn(entries, name))
            throw new TypeError("Generated/global/domain name collision.");
        const v = definition.value;
        entries[name] = Object.freeze({ definition: frozenJson(definition), target, global, help: frozenJson({ name, description: definition.description,
                kind: v.kind === "boolean" ? "boolean" : "value", source, required: definition.required === true,
                repeatable: definition.repeatable === true, value: v,
                ...(definition.fileSource ? { fileAlternative: { name: `${name}-file`, maxBytes: definition.fileSource.maxBytes } } : {}),
                ...(definition.credential ? { credentialEnv: definition.credential.env } : {}), ...(v.kind !== "boolean" ? { valuePlaceholder: `<${v.kind === "file" || v.kind === "output-path" ? "path" : v.kind}>` } : {}),
                ...(v.kind === "enum" ? { choices: v.values } : {}), ...(definition.default !== undefined ? { default: definition.default } : {}) }) });
    };
    for (const [flags, global] of [[globals, true], [spec.flags, false]])
        for (const [name, flag] of Object.entries(flags)) {
            add(name, flag, global ? "global" : "domain", name, global);
            if (flag.fileSource)
                add(`${name}-file`, { description: `Read ${name} from a file or stdin (-).`, value: { kind: "file", maxBytes: flag.fileSource.maxBytes } }, "file", name, global);
        }
    const selectors = Object.create(null);
    if (spec.levels !== undefined) {
        if (spec.effects !== "read")
            throw new TypeError("Only reads declare levels.");
        assertRecord(spec.levels);
        for (const [level, declaration] of Object.entries(spec.levels)) {
            checkName(level);
            assertRecord(declaration);
            assertFields(declaration, ["output"], ["selectors"]);
            if (!["bounded", "artifact-eligible"].includes(declaration.output))
                throw new TypeError("Invalid level output.");
            const set = declaration.selectors ?? [level];
            if (!Array.isArray(set) || set.length === 0 || new Set(set).size !== set.length)
                throw new TypeError("Invalid selector inventory.");
            for (const name of set) {
                checkName(name);
                if (Object.hasOwn(frameworkFlags, name))
                    throw new TypeError("Reserved selector.");
                if (entries[name]?.help.source !== "selector")
                    add(name, { description: `Select ${level} detail.`, value: { kind: "boolean" } }, "selector");
            }
            for (const previous of Object.values(selectors)) {
                const subset = set.every(n => previous.includes(n));
                const superset = previous.every(n => set.includes(n));
                if (subset && superset || !subset && !superset && set.some(n => previous.includes(n)))
                    throw new TypeError("Ambiguous selector sets.");
            }
            selectors[level] = Object.freeze([...set]);
        }
    }
    if (spec.payload !== undefined) {
        assertRecord(spec.payload);
        assertFields(spec.payload, spec.effects === "write" ? ["maxBytes", "validatePath"] : ["maxBytes"]);
        bytes(spec.payload.maxBytes);
        if (spec.effects === "write")
            checkPath(spec.payload.validatePath);
        add("file", { description: "Read structured payload from a file or stdin (-).", value: { kind: "file", maxBytes: spec.payload.maxBytes }, required: true }, "payload");
    }
    for (const name of ["help", "json", "version"])
        add(name, { description: `${name} output.`, value: { kind: "boolean" } }, "framework");
    if (spec.output === "binary" || Object.values(spec.levels ?? {}).some(l => l.output === "artifact-eligible"))
        add("out", { description: "Write artifact to this output destination. Relative paths resolve inside the artifact directory; absolute paths must stay inside it. The parent directory must exist. Existing files are reused only when their bytes are identical; they are never overwritten.", value: { kind: "output-path" } }, "framework");
    return Object.freeze({ spec, flags: Object.freeze(entries), selectors: Object.freeze(selectors) });
}
/** Checks caller/example records without reading a selected source or environment. */
export function checkCaller(model, caller, suggestion) {
    const input = frozenJson(caller);
    assertRecord(input);
    assertFields(input, [], ["args", "flags", "file", "level", "out", "passthrough"]);
    const suppliedArgs = Object.hasOwn(input, "args") ? input["args"] : {};
    const suppliedFlags = Object.hasOwn(input, "flags") ? input["flags"] : {};
    assertRecord(suppliedArgs);
    assertRecord(suppliedFlags);
    const resultArgs = Object.create(null);
    const resultFlags = Object.create(null);
    const globals = Object.create(null);
    const sources = [];
    const credentials = [];
    const resolveValue = (definition, raw, required, label, path) => {
        const many = definition.repeatable || definition.variadic;
        if (raw === undefined) {
            if (definition.default !== undefined)
                return scalar(definition.value, definition.default);
            if (required)
                throw new InputValidationError(label, path);
            return many ? [] : undefined;
        }
        if (many) {
            if (!Array.isArray(raw))
                throw new TypeError("Expected repeated input array.");
            if (required && raw.length === 0)
                throw new InputValidationError(label, path);
            return raw.map(item => callerValue(definition.value, item, label, path));
        }
        return callerValue(definition.value, raw, label, path);
    };
    assertFields(suppliedArgs, [], model.spec.args.map(a => a.name));
    for (const arg of model.spec.args) {
        const resolved = resolveValue(arg, Object.hasOwn(suppliedArgs, arg.name) ? suppliedArgs[arg.name] : undefined, arg.required !== false && arg.default === undefined, `argument <${arg.name}>`, ["args", arg.name]);
        if (resolved !== undefined)
            resultArgs[arg.name] = resolved;
        if (arg.value.kind === "file" && typeof resolved === "string")
            sources.push({ kind: "argument", name: arg.name, path: resolved, maxBytes: arg.value.maxBytes });
    }
    assertFields(suppliedFlags, [], Object.keys(model.flags).filter(n => ["domain", "global", "file"].includes(model.flags[n].help.source)));
    for (const [name, entry] of Object.entries(model.flags)) {
        if (!["domain", "global"].includes(entry.help.source))
            continue;
        const def = entry.definition;
        const target = entry.global ? globals : resultFlags;
        const raw = Object.hasOwn(suppliedFlags, name) ? suppliedFlags[name] : undefined;
        const alternative = def.fileSource && Object.hasOwn(suppliedFlags, `${name}-file`) ? suppliedFlags[`${name}-file`] : undefined;
        if (suggestion && def.secret && raw !== undefined)
            throw new TypeError("Invocation cannot include secret flags.");
        if (raw !== undefined && alternative !== undefined)
            throw new TypeError("Inline and file inputs are exclusive.");
        if (alternative !== undefined) {
            const path = scalar({ kind: "file", maxBytes: def.fileSource.maxBytes }, alternative);
            sources.push({ kind: entry.global ? "global" : "flag", name, path, maxBytes: def.fileSource.maxBytes });
            continue;
        }
        if (raw === undefined && def.credential) {
            credentials.push({ name, env: def.credential.env, global: entry.global, required: def.required === true });
            continue;
        }
        const resolved = resolveValue(def, raw, def.required === true, `flag --${name}${def.fileSource ? ` (or --${name}-file)` : ""}`, [entry.global ? "globals" : "flags", name]);
        if (resolved !== undefined)
            target[name] = resolved;
        if (def.value.kind === "file" && typeof resolved === "string")
            sources.push({ kind: entry.global ? "global" : "flag", name, path: resolved, maxBytes: def.value.maxBytes });
    }
    const extra = {};
    if (model.spec.payload) {
        if (input["file"] === undefined)
            throw new InputValidationError("payload file --file", ["file"]);
        extra.file = scalar({ kind: "file", maxBytes: model.spec.payload.maxBytes }, input["file"]);
        sources.push({ kind: "payload", name: "file", path: extra.file, maxBytes: model.spec.payload.maxBytes });
    }
    else if (input["file"] !== undefined)
        throw new TypeError("Unexpected payload file.");
    if (input["level"] !== undefined) {
        if (typeof input["level"] !== "string" || !Object.hasOwn(model.selectors, input["level"]))
            throw new TypeError("Unknown detail level.");
        extra.level = input["level"];
    }
    if (input["out"] !== undefined) {
        if (model.spec.output !== "binary" && (extra.level === undefined || model.spec.levels?.[extra.level]?.output !== "artifact-eligible"))
            throw new TypeError("Output path requires artifact-eligible selection.");
        extra.out = scalar(model.flags["out"].definition.value, input["out"]);
    }
    if (model.spec.passthrough) {
        const tokens = Object.hasOwn(input, "passthrough") ? input["passthrough"] : [];
        if (!Array.isArray(tokens) || tokens.some(t => typeof t !== "string"))
            throw new TypeError("Invalid passthrough tokens.");
        extra.passthrough = tokens;
    }
    else if (input["passthrough"] !== undefined)
        throw new TypeError("Undeclared passthrough.");
    if (sources.filter(s => s.path === "-").length > 1)
        throw new TypeError("Multiple stdin consumers are forbidden.");
    return frozenJson({ args: resultArgs, flags: resultFlags, globals, sources, credentials, ...extra });
}
//# sourceMappingURL=input-model.js.map