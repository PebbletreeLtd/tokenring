/**
 * Test implementation of TokenRingStorageAdapter.
 * 
 * Wraps an in-memory MVCC store for the WorkflowRingRegistration table,
 * implementing the storage interface that the token ring depends on.
 */
import type { TokenRingStorageAdapter, TokenRingRegistrationValue } from "../src/tokenRingTypes"
import { TestingStore } from "./store"


export class TestTokenRingStorageAdapter implements TokenRingStorageAdapter<TokenRingRegistrationValue> {
    doTn = TestingStore.doTransaction.bind(TestingStore)
}
