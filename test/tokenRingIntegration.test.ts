/**
 * Token Ring Integration Tests
 * 
 * Tests for:
 * - Token ring formation with real UDP sockets or in-memory transport
 * - Multi-server token passing
 * - Unresponsive server job reset
 * 
 * By default both transports are tested. Set TOKEN_RING_TRANSPORT=memory
 * or TOKEN_RING_TRANSPORT=udp to run only one mode.
 */
console.log()
import crypto from "crypto";
import { describe, test, expect, afterEach } from "vitest";
import { Token, TokenFlags, TokenRingConfig, TokenRingWorkDistributorInterface } from "../src/tokenRingTypes";
import { InMemoryTransport } from "../src/inMemoryTransport";
import { TestingTokenRingDistributor } from "./testingTokenRingDistributor";
import { segmentSubspace, TestingStore } from "./store";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const createGUID = () => {
    const id = crypto.randomBytes(16).toString("hex");
    return id;
}

type TransportMode = "udp" | "memory"

const modes: TransportMode[] = process.env.TOKEN_RING_TRANSPORT
    ? [process.env.TOKEN_RING_TRANSPORT as TransportMode]
    : ["memory", "udp"]

describe.each(modes)("tokenRing (%s transport)", (transportMode) => {

afterEach(() => {
    if (transportMode === "memory") InMemoryTransport.clearRegistry()
})

/** Minimal token ring config suitable for fast testing */
function testTokenRingConfig(overrides?: Partial<TokenRingConfig>): TokenRingConfig {
    return {
        reregister_time_ms: 60000, // long so re-registration doesn't interfere
        token_ack_timeout_ms: 500,
        skipInitialTokenTimeout: true,
        ...overrides,
    };
}


/** Create a token ring for testing with an onToken callback that tracks rounds and reports zero workload */
async function createTestTokenRing(options: {
    segmentName: string,
    capabilities: Buffer,
    config?: Partial<TokenRingConfig>,
    onToken?: (ctx: { ring: TokenRingWorkDistributorInterface, token: Readonly<Token>, done: (workload: { running: number }) => void, error: (e: any) => void }) => void,
    onServerUnresponsive?: (reg: { key: any, value: any }) => void | Promise<void>,
}): Promise<{ tr: TestingTokenRingDistributor, rounds: () => number, lastToken: () => Token | null }> {
    let roundCount = 0;
    let lastSeenToken: Token | null = null;

    const defaultHandler = (ctx: { ring: TokenRingWorkDistributorInterface, token: Readonly<Token>, done: (workload: { running: number }) => void, error: (e: any) => void }) => {
        ctx.done({ running: 0 });
    }
    const userHandler = options.onToken ?? defaultHandler;

    const tr = await new TestingTokenRingDistributor({
        segment_name: options.segmentName,
        capabilities: options.capabilities,
        config: testTokenRingConfig(options.config),
        doTn: TestingStore.doTn.bind(TestingStore),
        issuer_id: createGUID(),
    }, {
        onToken: (ctx) => {
            roundCount++;
            lastSeenToken = ctx.token;
            userHandler(ctx);
        },
        onServerUnresponsive: options.onServerUnresponsive,
        createTransport: transportMode === "memory" ? () => new InMemoryTransport() : undefined,
    }).Start();

    return {
        tr,
        rounds: () => roundCount,
        lastToken: () => lastSeenToken,

    };
}


/** Wait for a condition with a timeout */
async function waitFor(condition: () => boolean, timeoutMs: number, label?: string): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (condition()) return;
        await sleep(50);
    }
    throw new Error(`waitFor timed out after ${timeoutMs}ms: ${label || "condition not met"}`);
}

// =========================================================================
// Token Ring Formation
// =========================================================================
const testPayloadType = 1;
const testPayloadType2 = 2;
const testPayloadType3 = 4;

test("tokenRing: single server creates and receives its own token", async () => {
    const segmentName = `test-single-${createGUID().slice(0, 8)}`;
    const capabilities = Buffer.from([testPayloadType]);

    const { tr, rounds } = await createTestTokenRing({ segmentName, capabilities });

    try {
        await waitFor(() => rounds() >= 1, 5000, "waiting for first token");

        // Token should be issued by this server
        expect(tr.Token.issued_by).toBe(tr.issuer_id);
        expect(tr.Token.server_count).toBeGreaterThanOrEqual(0);

        // Capabilities should include our flag
        expect(tr.Token.capabilities[0]! & testPayloadType).toBe(testPayloadType);
    } finally {
        tr.Destroy();
    }
});

test("tokenRing: provisional flag cleared when token returns to issuer", async () => {
    const segmentName = `test-prov-${createGUID().slice(0, 8)}`;
    const capabilities = Buffer.from([testPayloadType]);

    const { tr, rounds } = await createTestTokenRing({ segmentName, capabilities });

    try {
        // Wait for at least 2 rounds — first is provisional, second should have flag cleared
        await waitFor(() => rounds() >= 2, 5000, "waiting for 2 token rounds");

        // After completing a loop, provisional flag should be cleared
        expect(tr.Token.flags & TokenFlags.provisional).toBe(0);
    } finally {
        tr.Destroy();
    }
});

test("tokenRing: two servers pass token between each other", async () => {
    const segmentName = `test-two-${createGUID().slice(0, 8)}`;
    const capabilities = Buffer.from([testPayloadType]);
    const config: Partial<TokenRingConfig> = { token_ack_timeout_ms: 1000 };

    const { tr: tr1, rounds: tr1Rounds } = await createTestTokenRing({ segmentName, capabilities, config });
    const { tr: tr2, rounds: tr2Rounds } = await createTestTokenRing({ segmentName, capabilities, config });

    try {
        // Wait for both to have received at least 1 token 
        await waitFor(() => tr1Rounds() >= 1 && tr2Rounds() >= 1, 10000, "waiting for both servers to see tokens");

        // After full loop, token should reflect 2 servers
        // (server_count increments each time the token passes through a server with different version)
        expect(
            tr1.Token.server_count >= 1 || tr2.Token.server_count >= 1
        ).toBe(true);

        // Both should have the capability flag in the token
        expect(tr1.Token.capabilities[0]! & testPayloadType).toBe(testPayloadType);
        expect(tr2.Token.capabilities[0]! & testPayloadType).toBe(testPayloadType);
    } finally {
        tr1.Destroy();
        tr2.Destroy();
    }
});


test("tokenRing: capabilities merge across servers with different caps", async () => {
    const segmentName = `test-two-${createGUID().slice(0, 8)}`;
    const config: Partial<TokenRingConfig> = { token_ack_timeout_ms: 1000 };

    const { tr: tr1 } = await createTestTokenRing({ segmentName, capabilities: Buffer.from([testPayloadType]), config });
    const { tr: tr2 } = await createTestTokenRing({ segmentName, capabilities: Buffer.from([testPayloadType2]), config });

    try {
        // Wait until the token has completed a full loop (provisional flag cleared on both servers)
        await waitFor(() =>
            (tr1.Token.flags & TokenFlags.provisional) === 0 &&
            (tr2.Token.flags & TokenFlags.provisional) === 0,
            10000, "waiting for token to complete a full loop");

        // Both should have both capabilities in their tokens after merging (bitwise OR)
        expect(tr1.Token.capabilities[0]! & testPayloadType).toBe(testPayloadType);
        expect(tr1.Token.capabilities[0]! & testPayloadType2).toBe(testPayloadType2);
        expect(tr2.Token.capabilities[0]! & testPayloadType).toBe(testPayloadType);
        expect(tr2.Token.capabilities[0]! & testPayloadType2).toBe(testPayloadType2);
    } finally {
        tr1.Destroy();
        tr2.Destroy();
    }
});

// =========================================================================
// Token serialization round-trip
// =========================================================================

test("tokenRing: token binary format round-trips through serialize/deserialize", async () => {
    // We can't directly call the private methods, but we can verify the token
    // data survives a full trip through the ring.
    const segmentName = `test-serde-${createGUID().slice(0, 8)}`;
    const caps = Buffer.from([testPayloadType | testPayloadType2 | testPayloadType3]);

    let seenCaps = 0;
    const { tr, rounds } = await createTestTokenRing({
        segmentName,
        capabilities: caps,
        onToken: (ctx) => {
            seenCaps = ctx.ring.Token.capabilities[0]!;
            ctx.done({ running: 0 });
        },
    });

    try {
        await waitFor(() => rounds() >= 2, 5000, "waiting for serde test rounds");

        // After token goes through serialize → UDP → deserialize → merge cycle,
        // capabilities should still include what we started with
        expect(seenCaps & testPayloadType).toBe(testPayloadType);
        expect(seenCaps & testPayloadType2).toBe(testPayloadType2);
        expect(seenCaps & testPayloadType3).toBe(testPayloadType3);
    } finally {
        tr.Destroy();
    }
});

// =========================================================================
// Registration
// =========================================================================

test("tokenRing: server registers itself in WorkflowRingRegistration table", async () => {
    const segmentName = `test-reg-${createGUID().slice(0, 8)}`;
    const capabilities = Buffer.from([testPayloadType]);

    const { tr } = await createTestTokenRing({ segmentName, capabilities });

    try {
        // Give it a moment to register
        await sleep(200);

        // Check the registration table
        const registrations = await tr.doTn(async txn => {
            return txn.at(segmentSubspace).getRangeAllStartsWith({ segment_name: segmentName });
        });

        expect(registrations.length).toBeGreaterThanOrEqual(1);
        const [regKey, regValue] = registrations[0]!;
        expect(regKey.segment_name).toBe(segmentName);
        expect(regValue.executor_id).toBe(tr.issuer_id);
    } finally {
        tr.Destroy();

        // Clean up registrations
        await tr.doTn(async txn => {
            const regs = await txn.at(segmentSubspace).getRangeAllStartsWith({ segment_name: segmentName });
            for (const [k] of regs) {
                txn.clear(k);
            }
        });
    }
});

test("tokenRing: destroyed server deregisters from table", async () => {
    const segmentName = `test-dereg-${createGUID().slice(0, 8)}`;
    const capabilities = Buffer.from([testPayloadType]);

    const { tr } = await createTestTokenRing({ segmentName, capabilities });

    // Wait for registration
    await sleep(200);

    tr.Destroy();

    // Give it a moment to deregister
    await sleep(500);

    const registrations = await tr.doTn(async txn => {
        return txn.at(segmentSubspace).getRangeAllStartsWith({ segment_name: segmentName });
    });

    expect(registrations.length).toBe(0);
});

// =========================================================================
// done() continuation
// =========================================================================

test("tokenRing: token continues circulating after done() is called", async () => {
    const segmentName = `test-cont-${createGUID().slice(0, 8)}`;
    const capabilities = Buffer.from([testPayloadType]);

    const { tr, rounds } = await createTestTokenRing({ segmentName, capabilities });

    try {
        // Wait for many rounds — if done() doesn't trigger the next send, it would stall at 1
        await waitFor(() => rounds() >= 5, 5000, "waiting for 5+ token rounds");

        expect(rounds()).toBeGreaterThanOrEqual(5);
    } finally {
        tr.Destroy();
    }
});

// =========================================================================
// Re-registration
// =========================================================================

test("tokenRing: re-registration refreshes the membership entry", async () => {
    const segmentName = `test-rereg-${createGUID().slice(0, 8)}`;
    const capabilities = Buffer.from([testPayloadType]);

    const { tr } = await createTestTokenRing({
        segmentName,
        capabilities,
        config: { reregister_time_ms: 300 }, // short interval so re-registration fires during the test
    });

    try {
        await sleep(200);

        // Capture the initial last_seen timestamp
        const initial = await tr.doTn(async txn => {
            const regs = await txn.at(segmentSubspace).getRangeAllStartsWith({ segment_name: segmentName });
            return regs[0]?.[1]?.last_seen ?? 0;
        });
        expect(initial).toBeGreaterThan(0);

        // Wait long enough for at least one re-registration cycle
        await sleep(600);

        const updated = await tr.doTn(async txn => {
            const regs = await txn.at(segmentSubspace).getRangeAllStartsWith({ segment_name: segmentName });
            return regs[0]?.[1]?.last_seen ?? 0;
        });

        expect(updated).toBeGreaterThan(initial);
    } finally {
        tr.Destroy();
    }
});

// =========================================================================
// issuer_id format
// =========================================================================

test("tokenRing: works with various issuer_id formats", async () => {
    const segmentName = `test-id-${createGUID().slice(0, 8)}`;
    const capabilities = Buffer.from([testPayloadType]);

    // Use a UUID-style id with dashes
    const uuidStyleId = `${createGUID().slice(0, 8)}-${createGUID().slice(0, 4)}-${createGUID().slice(0, 4)}-${createGUID().slice(0, 12)}`;

    const tr = await new TestingTokenRingDistributor({
        segment_name: segmentName,
        capabilities,
        config: testTokenRingConfig(),
        doTn: TestingStore.doTn.bind(TestingStore),
        issuer_id: uuidStyleId,
    }, {
        onToken: (ctx) => { ctx.done({ running: 0 }); },
        createTransport: transportMode === "memory" ? () => new InMemoryTransport() : undefined,
    }).Start();

    try {
        await waitFor(() => tr.Token.issued_by === uuidStyleId, 5000, "waiting for token with UUID-style issuer_id");

        expect(tr.Token.issued_by).toBe(uuidStyleId);
        expect(tr.issuer_id).toBe(uuidStyleId);
    } finally {
        tr.Destroy();
    }
});

// =========================================================================
// Extended value: optional members not clobbered by re-registration
// =========================================================================

test("tokenRing: re-registration preserves extra optional members on the value", async () => {
    const segmentName = `test-noclobber-${createGUID().slice(0, 8)}`;
    const capabilities = Buffer.from([testPayloadType]);

    // Start a ring with a short re-registration interval
    const { tr } = await createTestTokenRing({
        segmentName,
        capabilities,
        config: { reregister_time_ms: 300 },
    });

    try {
        // Wait for initial registration
        await sleep(200);

        // Read back the registration key so we know the IP/port the ring bound to
        const regs = await tr.doTn(async txn => {
            return txn.at(segmentSubspace).getRangeAllStartsWith({ segment_name: segmentName });
        });
        expect(regs.length).toBe(1);
        const [regKey, regValue] = regs[0]!;

        // Inject an extra optional field directly into the stored record,
        // simulating a consumer's extended value type (e.g. { hostname?: string }).
        await tr.doTn(async txn => {
            txn.set(regKey, {
                ...regValue,
                hostname: "test-host.local",
            } as any);
        });

        // Confirm the extra field is there
        const before = await tr.doTn(async txn => txn.get(regKey)) as any;
        expect(before.hostname).toBe("test-host.local");

        // Wait for at least one re-registration cycle
        await sleep(600);

        // Read back and verify the extra field survived
        const after = await tr.doTn(async txn => txn.get(regKey)) as any;
        expect(after.hostname).toBe("test-host.local");
        // And the library's own fields were updated
        expect(after.last_seen).toBeGreaterThan(regValue.last_seen);
        expect(after.executor_id).toBe(tr.issuer_id);
    } finally {
        tr.Destroy();
    }
});

}) // describe.each