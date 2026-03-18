import {
    MVCCCore
} from "@pebbletree/mvcc-testing"
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

// ─── Storage Adapter ─────────────────────────────────────────────────


/**
 * Storage adapter for the token ring's membership registry.
 * 
 * Implementations may return T or Promise<T> — the token ring
 * awaits either transparently.
 */
export interface TokenRingStorageAdapter {
    /** access to the underlying table for registrations */
    doTn: MVCCCore.TransactionFactory<TokenRingRegistrationKey, TokenRingRegistrationValue>
    subspace: MVCCCore.ISubspace<TokenRingRegistrationKey, TokenRingRegistrationKey, TokenRingRegistrationValue, TokenRingRegistrationValue>
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

// ─── Callbacks ───────────────────────────────────────────────────────

/**
 * Called each time the token passes through this server.
 * The handler should do its work (e.g. pick and start jobs),
 * then call `done()` with the current workload to resume token forwarding.
 */
export type TokenRingOnTokenHandler = (ctx: {
    ring: TokenRingWorkDistributorInterface
    token: Readonly<Token>
    done: (workload: { running: number }) => void
    error: (e: any) => void
}) => void

/**
 * Called when the token ring detects that a server is unresponsive
 * (failed to ACK a forwarded token). The ring has already removed 
 * the dead server's registration. The consumer is responsible for 
 * any cleanup (e.g. resetting orphaned jobs).
 */
export type TokenRingOnServerUnresponsiveHandler = (registration: {
    key: TokenRingRegistrationKey
    value: TokenRingRegistrationValue
}) => void | Promise<void>

// ─── Public interface of the ring (exposed to onToken handler) ───────

export interface TokenRingWorkDistributorInterface {
    readonly issuer_id: string
    readonly segmentName: string
    readonly config: Readonly<TokenRingConfig>
    readonly Token: Readonly<Token>
    readonly last_seen_token: Readonly<{ token: Token, last_seen: number }>
    Destroy(cause?: any): void
}

// ─── Constructor options ─────────────────────────────────────────────

export interface TokenRingOptions {
    segment_name: string
    capabilities: Buffer
    issuer_id: string,
    config: TokenRingConfig
    storage: TokenRingStorageAdapter
    onToken: TokenRingOnTokenHandler
    onServerUnresponsive?: TokenRingOnServerUnresponsiveHandler
    onError?: (e: any) => void
    onDestroy?: () => void
    /**
     * Optional: override local IP/interface discovery.
     * Defaults to finding the first non-internal IPv4 interface matching /^e.*0$/ (eth0, en0, etc.)
     */
    getLocalAddress?: () => { address: string }
}
