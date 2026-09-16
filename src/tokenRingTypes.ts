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
    /**
     * Optional freeform debug logger. Called at every meaningful transition
     * in the ring. Wire it to your log framework when you need to trace a
     * production stall.
     */
    debugLog?: (...args: any[]) => void
    /**
     * Optional structured testing hook. Called with a well-known enum event
     * and a details record at every observable ring transition. Prefer this
     * over grepping `debugLog` output when writing assertions.
     */
    onTestingEvent?: TokenRingTestObserver
}

/**
 * Stable enum of every observable ring transition. Add new members only —
 * removing or renaming a member is a breaking change for downstream tests.
 */
export enum TokenRingTestEvent {
    /** Transport delivered a "token" message to us (before any drop check). */
    TransportTokenIn = "TransportTokenIn",
    /** BindTransportEvents silently discarded a token whose (issued_by, version) is <= last_seen. */
    TokenDroppedAsDuplicate = "TokenDroppedAsDuplicate",
    /** BindTransportEvents saw a token strictly greater than last_seen (about to adopt). */
    TokenAdopted = "TokenAdopted",
    /** TokenReceived body started running (either from wire or self-issue). */
    TokenReceivedEnter = "TokenReceivedEnter",
    /** TokenReceived body completed. */
    TokenReceivedExit = "TokenReceivedExit",
    /** Pass-on while-loop broke because last_seen was mutated (concurrent TokenReceived). */
    PassOnSkippedStale = "PassOnSkippedStale",
    /** Pass-on sent the token to the next server. */
    PassOnSent = "PassOnSent",
    /** Pass-on send returned "ok". */
    PassOnAckOk = "PassOnAckOk",
    /** Pass-on send returned "timeout" for a non-self target — triggers MarkServerAsUnresponsive. */
    PassOnAckTimeout = "PassOnAckTimeout",
    /** Lost-token timer scheduled. */
    LostTokenTimerScheduled = "LostTokenTimerScheduled",
    /** Lost-token timer fired — about to self-issue a token. */
    LostTokenTimerFired = "LostTokenTimerFired",
    /** Register() started. */
    RegisterEnter = "RegisterEnter",
    /** Register() committed. */
    RegisterExit = "RegisterExit",
    /** MarkServerAsUnresponsive removed a peer registration. */
    ServerMarkedUnresponsive = "ServerMarkedUnresponsive",
    /** Start() completed successfully. */
    Started = "Started",
    /** Destroy() invoked (may be with or without cause). */
    Destroyed = "Destroyed",
}

export type TokenRingTestObserver = (event: TokenRingTestEvent, details: Record<string, unknown>) => void