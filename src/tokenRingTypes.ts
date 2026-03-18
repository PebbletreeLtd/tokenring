/**
 * Token Ring Abstraction Types
 * 
 * These interfaces define the boundaries of the token ring module,
 * decoupling it from specific storage backends (e.g. FoundationDB)
 * and application-level concerns (e.g. job management).
 * 
 * Designed for eventual extraction into a standalone npm package.
 */

import { TransactionFactory } from "@pebbletree/mvcc-testing/dist/types"

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

// ─── Callbacks ───────────────────────────────────────────────────────




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
    config: TokenRingConfig,
    doTn: TransactionFactory<TokenRingRegistrationKey, TokenRingRegistrationValue>;
}