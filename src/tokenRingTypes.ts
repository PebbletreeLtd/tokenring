/**
 * Token Ring Abstraction Types
 * 
 * These interfaces define the boundaries of the token ring module,
 * decoupling it from specific storage backends (e.g. FoundationDB)
 * and application-level concerns (e.g. job management).
 * 
 * Designed for eventual extraction into a standalone npm package.
 */


// ─── Ring Registration ───────────────────────────────────────────────

export interface TokenRingRegistrationKey {
    segment_name: string
    server_ip: string
    server_port: number
}

export interface TokenRingRegistrationValue {
    last_seen: number
    executor_id: string
}

// ─── Token ───────────────────────────────────────────────────────────

export enum TokenFlags {
    provisional = 1
}

export interface Token {
    issued_by: string
    issuer_version: number
    averageWorkload: number
    server_count: number
    capabilities: Buffer
    flags: TokenFlags
}



// ─── Config ──────────────────────────────────────────────────────────

export interface TokenRingConfig {
    /** How often to re-register in the membership table (ms) */
    reregister_time_ms: number
    /** How long to wait for an ACK after forwarding the token (ms) */
    token_ack_timeout_ms: number
    /** If true, skip the initial lost-token timeout and suppress the "token timeout" warning on first load */
    skipInitialTokenTimeout?: boolean
    /** If true, enable debug/info logging to console. Errors are always logged. Defaults to false. */
    verbose?: boolean
}



// ─── Public interface of the ring (exposed to onToken handler) ───────

export interface TokenRingWorkDistributorInterface {
    readonly issuer_id: string
    readonly segmentName: string
    readonly config: Readonly<TokenRingConfig>
    readonly Token: Readonly<Token>
    readonly last_seen_token: Readonly<{ token: Token, last_seen: number }>
    Destroy(cause?: any): void
}

// ─── Transport ───────────────────────────────────────────────────────

/**
 * Abstraction over the UDP worker thread. The default implementation
 * uses a real `worker_threads` Worker; swap in `InMemoryTransport`
 * for fast, deterministic tests without real sockets.
 */
export interface TokenRingTransport {
    on(event: "message", handler: (msg: any) => void): void
    removeListener(event: "message", handler: (msg: any) => void): void
    removeAllListeners(): void
    postMessage(msg: any): void
    terminate(): Promise<number>
    /**
     * Optional: if the transport knows what local address to bind to
     * (e.g. InMemoryTransport always uses 127.0.0.1), return it here.
     * When present, the base class defers to this instead of probing
     * real network interfaces.
     */
    getLocalAddress?(): { address: string }
}

// ─── Constructor options ─────────────────────────────────────────────
export interface StorageTxn<K, V> {
    get: (key: K) => Promise<V | undefined>
    set: (key: K, value: V) => void
    clear: (key: K) => void
    getRangeAll: (startKey: K, endKey: K, options?: { limit?: number; reverse?: boolean }) => Promise<Array<[K, V]>>
}
export interface TokenRingStorageAdapter {
    doTn: <R>(callback: (txn: {
        tokenRingRegistration: StorageTxn<TokenRingRegistrationKey, TokenRingRegistrationValue>
    }) => Promise<R>) => Promise<R>,
}


export interface TokenRingOptions {
    segment_name: string
    capabilities: Buffer
    issuer_id: string,
    config: TokenRingConfig,
    storage: TokenRingStorageAdapter
}