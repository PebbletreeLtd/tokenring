import { Token, TokenRingOptions, TokenRingRegistrationKey, TokenRingRegistrationValue, TokenRingTransport, TokenRingWorkDistributor, TokenRingWorkDistributorInterface } from "../src";
export class TestingTokenRingDistributor extends TokenRingWorkDistributor {
    constructor(args: TokenRingOptions, private options: {
        onToken: TokenRingWorkDistributor["onToken"],
        onServerUnresponsive?: TokenRingWorkDistributor["onServerUnresponsive"],
        createTransport?: () => TokenRingTransport,
    }) {
        super(args);
    }
    onToken(ctx: { ring: TokenRingWorkDistributorInterface; token: Readonly<Token>; done: (workload: { running: number; }) => void; error: (e: any) => void; }): void {
        return this.options.onToken(ctx)
    }
    onServerUnresponsive(registration: { key: TokenRingRegistrationKey; value: TokenRingRegistrationValue; }): void | Promise<void> {
        return this.options.onServerUnresponsive?.(registration);
    }
    protected createTransport(): TokenRingTransport {
        if (this.options.createTransport) return this.options.createTransport()
        return super.createTransport()
    }
    getLocalAddress() {
        if (this.options.createTransport) return { address: "127.0.0.1" }
        return super.getLocalAddress()
    }

}