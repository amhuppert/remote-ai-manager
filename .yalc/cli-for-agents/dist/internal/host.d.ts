export declare function checkLimit(limit: number): void;
export declare function checkDuration(duration: number): void;
export declare function overflow(): RangeError;
export declare function collisionError(): Error;
export declare function sameBytes(left: Uint8Array, right: Uint8Array): boolean;
export declare function hashBytes(data: Uint8Array): Promise<string>;
export declare function hasCode(error: unknown, code: string): boolean;
//# sourceMappingURL=host.d.ts.map