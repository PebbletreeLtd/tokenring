import { MVCCStore } from "@pebbletree/mvcc-testing"
import { TokenRingRegistrationKey } from "../src"
import { TokenRingRegistrationValue } from "../src/tokenRingTypes"
export const TestingStore = new MVCCStore<TokenRingRegistrationKey, TokenRingRegistrationValue>()