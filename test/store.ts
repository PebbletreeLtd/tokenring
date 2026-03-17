import { MVCCCore } from "@pebbletree/mvcc-testing"
import { TokenRingRegistrationKey } from "../src"
import { TokenRingRegistrationValue } from "../src/tokenRingTypes"
import tuple from "fdb-tuple"
export const TestingStore = new MVCCCore.MVCCStore<TokenRingRegistrationKey, TokenRingRegistrationKey, TokenRingRegistrationValue, TokenRingRegistrationValue>(
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

export const BySegmentName = new MVCCCore.Subspace<{ segment_name: string }, TokenRingRegistrationKey, TokenRingRegistrationValue, TokenRingRegistrationValue>({
    pack: (value) => tuple.pack([value.segment_name]),
    unpack: (packed) => TestingStore.keyXf.unpack(packed)
})
