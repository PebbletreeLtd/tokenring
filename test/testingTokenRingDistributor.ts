import { Token, TokenRingOptions, TokenRingRegistrationKey, TokenRingRegistrationValue, TokenRingWorkDistributor, TokenRingWorkDistributorInterface } from "../src";
export class TestingTokenRingDistributor extends TokenRingWorkDistributor {
    constructor(args: TokenRingOptions, private options: {
        onToken: TokenRingWorkDistributor["onToken"],
        onServerUnresponsive?: TokenRingWorkDistributor["onServerUnresponsive"],
    }) {
        super(args);
    }
    onToken(ctx: { ring: TokenRingWorkDistributorInterface; token: Readonly<Token>; done: (workload: { running: number; }) => void; error: (e: any) => void; }): void {
        return this.options.onToken(ctx)
    }
    onServerUnresponsive(registration: { key: TokenRingRegistrationKey; value: TokenRingRegistrationValue; }): void | Promise<void> {
        return this.options.onServerUnresponsive?.(registration);
    }


}