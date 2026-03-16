/**
 * Test implementation of TokenRingStorageAdapter.
 * 
 * Wraps an in-memory MVCC store for the WorkflowRingRegistration table,
 * implementing the storage interface that the token ring depends on.
 */
import type { TokenRingStorageAdapter, TokenRingRegistrationKey, TokenRingRegistrationValue } from "../src/tokenRingTypes"
import { TestingStore } from "./store"


export class TestTokenRingStorageAdapter implements TokenRingStorageAdapter {
    private store = TestingStore
    constructor() {
    }
    async register(key: TokenRingRegistrationKey, value: TokenRingRegistrationValue): Promise<void> {
        return this.store.doTransaction(async txn => {
            txn.set(key, value)
        })
    }

    async deregister(key: TokenRingRegistrationKey): Promise<void> {
        return this.store.doTransaction(async txn => {
            txn.clear(key)
        })
    }

    async getNextInRing(afterKey: TokenRingRegistrationKey, segmentName: string): Promise<TokenRingRegistrationKey | null> {
        return this.store.doTransaction(async txn => {
            //get all servers
            const allServers = txn.getUsingFilter((v) => v.segment_name === segmentName);
            allServers.sort((a, b) => a[0].server_ip.localeCompare(b[0].server_ip) || a[0].server_port - b[0].server_port)
            const firstGreateThan = allServers.find(kv => {
                const cmp = kv[0].segment_name.localeCompare(afterKey.segment_name) || kv[0].server_ip.localeCompare(afterKey.server_ip) || kv[0].server_port - afterKey.server_port
                return cmp > 0
            })
            if (firstGreateThan) return firstGreateThan[0]
            const [first] = allServers
            return first ? first[0] : null
        })
    }

    async removeRegistration(key: TokenRingRegistrationKey): Promise<TokenRingRegistrationValue | null> {
        return this.store.doTransaction(async txn => {
            const val = txn.get(key)
            if (val) {
                txn.clear(key)
            }
            return val ?? null
        })
    }
}
