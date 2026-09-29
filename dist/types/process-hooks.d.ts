export interface Flushable {
    flush(): Promise<void>;
    finalFlushNow(): Promise<void>;
    hasPendingData(): boolean;
    recordError(error: any): void;
}
export declare function registerCollector(collector: Flushable, options: {
    processHooks?: unknown;
}): void;
export declare function unregisterCollector(collector: Flushable): void;
/** Flush every live collector, giving up after `timeoutMs`. Never rejects. */
export declare function flushAll(timeoutMs?: number): Promise<void>;
/** Test seam: which collectors the hooks will flush. */
export declare function registeredCollectorCount(): number;
