import { MVCCCore } from "@pebbletree/mvcc-testing"
import { TokenRingRegistrationKey, TokenRingRegistrationValue } from "../src"
import tuple from "fdb-tuple"
export const TestingStore = new MVCCCore.Store<TokenRingRegistrationKey, TokenRingRegistrationKey, TokenRingRegistrationValue, TokenRingRegistrationValue>(
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
export const segmentSubspace = new MVCCCore.Subspace<{ segment_name: string }, TokenRingRegistrationKey, TokenRingRegistrationValue, TokenRingRegistrationValue>({
    ...TestingStore.keyXf,
    pack: (value) => tuple.pack([value.segment_name]),
})