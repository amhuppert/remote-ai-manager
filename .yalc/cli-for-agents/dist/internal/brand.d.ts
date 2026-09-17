/** Not a public constructor: only the owning boundary may establish an invariant. */
declare const brand: unique symbol;
export type Brand<Name extends string, Scope = never> = {
    readonly [brand]: {
        readonly name: Name;
        readonly scope: Scope;
    };
};
export {};
//# sourceMappingURL=brand.d.ts.map