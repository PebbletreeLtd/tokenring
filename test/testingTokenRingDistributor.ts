import { MVCCCore } from "@pebbletree/mvcc-testing";
import { Token, TokenRingOptions, TokenRingRegistrationKey, TokenRingRegistrationValue, TokenRingWorkDistributor, TokenRingWorkDistributorInterface } from "../src";
import tuple from "fdb-tuple";
export class TestingTokenRingDistributor extends TokenRingWorkDistributor<MVCCCore.ITransaction<TokenRingRegistrationKey, TokenRingRegistrationKey, TokenRingRegistrationValue, TokenRingRegistrationValue>> {
    readonly TestingStore;
    readonly segmentSubspace;
    constructor(args: TokenRingOptions, private options: {
        store?: MVCCCore.Store<TokenRingRegistrationKey, TokenRingRegistrationKey, TokenRingRegistrationValue, TokenRingRegistrationValue>,
        onToken: TokenRingWorkDistributor<any>["onToken"],
        onServerUnresponsive?: TokenRingWorkDistributor<any>["onServerUnresponsive"],
    }) {
        super(args);
        this.TestingStore = options?.store ?? new MVCCCore.Store<TokenRingRegistrationKey, TokenRingRegistrationKey, TokenRingRegistrationValue, TokenRingRegistrationValue>(
            {
                keyTransformer: {
                    pack: (value) => tuple.pack([value.segment_name, value.server_ip, value.server_port]),
                    unpack: (packed) => {
                        const [segment_name, server_ip, server_port] = tuple.unpack(packed)
                        if (typeof segment_name !== "string" || typeof server_ip !== "string" || typeof server_port !== "number") {
                            throw new Error("Invalid key format")
                        }
                        return {
                            segment_name,
                            server_ip,
                            server_port,
                        }
                    }
                },
            }
        )
        this.segmentSubspace = new MVCCCore.Subspace<{ segment_name: string }, TokenRingRegistrationKey, TokenRingRegistrationValue, TokenRingRegistrationValue>({
            ...this.TestingStore.keyXf,
            pack: (value) => tuple.pack([value.segment_name]),
        })
    }
    onToken(ctx: { ring: TokenRingWorkDistributorInterface; token: Readonly<Token>; done: (workload: { running: number; }) => void; error: (e: any) => void; }): void {
        return this.options.onToken(ctx)
    }
    onServerUnresponsive(registration: { key: TokenRingRegistrationKey; value: TokenRingRegistrationValue; }): void | Promise<void> {
        return this.options.onServerUnresponsive?.(registration);
    }
    async GetNextServerInRing(txn: MVCCCore.ITransaction<TokenRingRegistrationKey, TokenRingRegistrationKey, TokenRingRegistrationValue, TokenRingRegistrationValue>): Promise<TokenRingRegistrationKey | null> {

        const [record] = await txn.getRangeAll(
            {
                segment_name: this.args.segment_name,
                server_ip: this.boundAddress.address,
                server_port: this.boundAddress.port + 1,
            },
            {
                segment_name: this.args.segment_name,
                server_ip: "\xFF",
                server_port: Number.MAX_SAFE_INTEGER,
            },
            {
                limit: 1
            }
        );
        return record ? record[0] : null
    }
    async GetFirstServerInRing(txn: MVCCCore.ITransaction<TokenRingRegistrationKey, TokenRingRegistrationKey, TokenRingRegistrationValue, TokenRingRegistrationValue>): Promise<TokenRingRegistrationKey | null> {
        const [record] = await txn.getRangeAll(
            {
                segment_name: this.args.segment_name,
                server_ip: "\x00",
                server_port: 0,
            },
            {
                segment_name: this.args.segment_name,
                server_ip: "\xFF",
                server_port: Number.MAX_SAFE_INTEGER,
            },
            {
                limit: 1
            }
        );
        return record ? record[0] : null
    }

    doTn<R>(callback: (txn: MVCCCore.ITransaction<TokenRingRegistrationKey, TokenRingRegistrationKey, TokenRingRegistrationValue, TokenRingRegistrationValue>) => Promise<R>): Promise<R> {
        return this.TestingStore.doTn(callback)
    }
    clearTokenRingRegistration(txn: MVCCCore.ITransaction<TokenRingRegistrationKey, TokenRingRegistrationKey, TokenRingRegistrationValue, TokenRingRegistrationValue>, key: TokenRingRegistrationKey): void {
        txn.clear(key)
    }
    async getTokenRingRegistration(txn: MVCCCore.ITransaction<TokenRingRegistrationKey, TokenRingRegistrationKey, TokenRingRegistrationValue, TokenRingRegistrationValue>, key: TokenRingRegistrationKey): Promise<TokenRingRegistrationValue | undefined> {
        return txn.get(key)
    }
    setTokenRingRegistration(txn: MVCCCore.ITransaction<TokenRingRegistrationKey, TokenRingRegistrationKey, TokenRingRegistrationValue, TokenRingRegistrationValue>, key: TokenRingRegistrationKey, value: TokenRingRegistrationValue): void {
        txn.set(key, value)
    }
}