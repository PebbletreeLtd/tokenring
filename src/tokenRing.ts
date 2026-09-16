import * as os from "os"
import * as path from "path"
import * as fs from "fs"
import { Worker } from "worker_threads"
import * as tuple from "fdb-tuple"
import {
    Token, TokenFlags,
    TokenRingRegistrationKey,
    TokenRingOptions,
    TokenRingConfig,
    TokenRingWorkDistributorInterface,
    TokenRingRegistrationValue,
    TokenRingTransport,
    TokenRingTestEvent,
    TokenRingTestObserver,
    StorageTxn,
} from "./tokenRingTypes"
interface Logger {
    debug(...args: any[]): void
    log(...args: any[]): void
    warn(...args: any[]): void
    error(...args: any[]): void
}

const noop = () => { }
function createLogger(verbose: boolean): Logger {
    return {
        debug: verbose ? console.debug.bind(console) : noop,
        log: verbose ? console.log.bind(console) : noop,
        warn: verbose ? console.warn.bind(console) : noop,
        error: console.error.bind(console),
    }
}

/** Signals a `waitForAToken` timeout — routed by the main loop into a self-issue path. */
class TokenTimeout extends Error {
    constructor() { super("TokenTimeout") }
}

/** Walk up from __dirname until we find a directory containing package.json */
const ProjectRoot = (() => {
    let dir = __dirname
    while (true) {
        if (fs.existsSync(path.join(dir, "package.json"))) return dir
        const parent = path.dirname(dir)
        if (parent === dir) throw new Error("Could not find project root")
        dir = parent
    }
})()

/**
 * Merge two capability buffers using bitwise OR.
 * Returns a buffer large enough to contain the larger of the two inputs.
 */
function mergeCapabilityBuffers(target: Buffer, source: Buffer): Buffer {
    const maxLen = Math.max(target.length, source.length)
    if (target.length < maxLen) {
        const newBuffer = Buffer.alloc(maxLen)
        target.copy(newBuffer)
        target = newBuffer
    }
    for (let i = 0; i < source.length; i++) {
        target[i] = target[i]! | source[i]!
    }
    return target
}

// Re-export types that consumers need



export abstract class TokenRingWorkDistributor implements TokenRingWorkDistributorInterface {
    readonly issuer_id;
    protected issuer_version = 1
    last_seen_token: { token: Token, last_seen: number }
    /** Single-slot ingress: highest-priority token seen but not yet processed. */
    protected pendingToken: Token | undefined = undefined
    /** Waiter registered by the main loop; woken by `enqueueToken` or the wait timeout. */
    protected tokenWaiter: { resolve: (t: Token) => void; reject: (e: unknown) => void } | undefined = undefined
    protected transport: TokenRingTransport | null = null
    protected boundAddress: { address: string, port: number } = { address: "", port: 0 }
    protected averageLoopDuration = process.platform === "darwin" ? 2500 : 30000
    protected readonly server_reregister_time_ms
    protected destroyed: boolean = false
    readonly segmentName
    readonly storage;
    readonly config: Readonly<TokenRingConfig>
    protected readonly log: Logger
    debugLog: (...args: any[]) => void
    protected readonly onTestingEvent: TokenRingTestObserver
    constructor(protected args: TokenRingOptions) {
        this.config = args.config
        this.log = createLogger(!!args.config.verbose)
        this.debugLog = args.debugLog ?? noop
        this.onTestingEvent = args.onTestingEvent ?? noop
        this.issuer_id = args.issuer_id
        this.server_reregister_time_ms = args.config.reregister_time_ms
        this.segmentName = args.segment_name
        this.last_seen_token = {
            last_seen: 0,
            token: {
                averageWorkload: 0,
                issued_by: "",
                issuer_version: 0,
                server_count: 0,
                capabilities: this.args.capabilities,
                flags: TokenFlags.provisional
            }
        }
        this.storage = args.storage
    }
    get Token() {
        return this.last_seen_token.token
    }

    /** Emit a structured test event and mirror to debugLog. */
    protected notify(event: TokenRingTestEvent, details: Record<string, unknown> = {}): void {
        this.debugLog(event, details)
        try { this.onTestingEvent(event, details) } catch (e) { /* observer errors are never fatal */ }
    }

    /**
     * Factory for the underlying transport (UDP socket worker).
     * Override to substitute an in-memory transport for testing.
     */
    protected createTransport(): TokenRingTransport {
        return new Worker(path.join(ProjectRoot, "dist", "udpWorker.js")) as unknown as TokenRingTransport
    }

    async Start() {
        try {
            this.transport = this.createTransport()
            await this.Listen()
            this.BindTransportEvents()
            await this.Register()
            this.RunRegistrationForever()
            void this.runMainLoop()
            this.notify(TokenRingTestEvent.Started, {
                issuer_id: this.issuer_id,
                bound_ip: this.boundAddress.address,
                bound_port: this.boundAddress.port,
            })
        } catch (e) {
            this.log.error("WorkflowInstance.Start", e)
            throw e;
        }
        return this
    }

    /** Compare two tokens by ring priority. Returns >0, <0 or 0. */
    protected compareTokens(a: Token, b: Token): number {
        if (a.issued_by !== b.issued_by) return a.issued_by > b.issued_by ? 1 : -1
        return a.issuer_version - b.issuer_version
    }

    /** Ingress from `BindTransportEvents`. Single-slot latch — highest survives. */
    protected enqueueToken(incoming: Token) {
        if (this.destroyed) return
        if (this.compareTokens(incoming, this.last_seen_token.token) < 0) {
            this.log.log("Dropping duplicate token", incoming.issued_by, incoming.issuer_version)
            this.notify(TokenRingTestEvent.TokenDroppedAsDuplicate, {
                issuer_id: this.issuer_id,
                issued_by: incoming.issued_by,
                issuer_version: incoming.issuer_version,
                last_seen_by: this.last_seen_token.token.issued_by,
                last_seen_version: this.last_seen_token.token.issuer_version,
            })
            return
        }
        if (this.pendingToken && this.compareTokens(incoming, this.pendingToken) < 0) return
        this.pendingToken = incoming
        const w = this.tokenWaiter
        this.tokenWaiter = undefined
        if (w) w.resolve(incoming)
    }

    /**
     * Await either the next token on the ingress or a timeout. Called only
     * from `runMainLoop` — never concurrently.
     */
    protected waitForAToken(timeoutMs: number): Promise<Token> {
        if (this.pendingToken) {
            const t = this.pendingToken
            this.pendingToken = undefined
            return Promise.resolve(t)
        }
        return new Promise<Token>((resolve, reject) => {
            const wrapped = (t: Token) => { clearTimeout(timer); resolve(t) }
            const timer = setTimeout(() => {
                if (this.tokenWaiter?.resolve === wrapped) this.tokenWaiter = undefined
                reject(new TokenTimeout())
            }, timeoutMs).unref()
            this.tokenWaiter = { resolve: wrapped, reject }
        })
    }

    /**
     * The ring's single serial main loop. Runs one token per iteration:
     * either a peer token arrives on the ingress, or the wait times out and
     * we self-issue. There is never more than one `processToken` in flight,
     * so `last_seen_token` cannot be overwritten mid-forward.
     */
    protected async runMainLoop(): Promise<void> {
        let firstWait = !!this.args.config.skipInitialTokenTimeout
        while (!this.destroyed) {
            const timeoutMs = firstWait
                ? 0
                : Math.max(this.averageLoopDuration * 3, 2000)
            firstWait = false
            this.notify(TokenRingTestEvent.LostTokenTimerScheduled, {
                issuer_id: this.issuer_id,
                timeout_ms: timeoutMs,
            })

            const prevLastSeen = this.last_seen_token.last_seen
            let token: Token
            try {
                token = await this.waitForAToken(timeoutMs)
            } catch (e) {
                if (this.destroyed) break
                if (!(e instanceof TokenTimeout)) { this.Destroy(e); break }
                // Timeout — self-issue a fresh provisional token.
                this.notify(TokenRingTestEvent.LostTokenTimerFired, {
                    issuer_id: this.issuer_id,
                    new_issuer_version: this.issuer_version + 1,
                })
                if (!this.args.config.skipInitialTokenTimeout)
                    this.log.warn(`Token receive timeout ${this.segmentName}`)
                token = {
                    issued_by: this.issuer_id,
                    server_count: 0,
                    issuer_version: ++this.issuer_version,
                    averageWorkload: this.last_seen_token.token.averageWorkload,
                    capabilities: this.args.capabilities,
                    flags: TokenFlags.provisional,
                }
            }

            try {
                await this.processToken(token)
            } catch (e) {
                this.Destroy(e)
                break
            }

            // Loop throttle: keep the ring from mad-spinning when we are the
            // only server. Uses the previous last_seen (before this iteration).
            if (prevLastSeen !== 0 && !this.destroyed) {
                let loopDuration = Date.now() - prevLastSeen
                if (loopDuration < 500) {
                    await new Promise(R => setTimeout(R, 500 - loopDuration).unref())
                    loopDuration = Date.now() - prevLastSeen
                }
                const alpha = 0.1
                this.averageLoopDuration = alpha * loopDuration + (1 - alpha) * this.averageLoopDuration
            }
        }
    }

    protected async Listen() {
        let listenPort = 5000;
        const localIP = this.getLocalAddress();
        while (listenPort < 65536) {
            try {
                await new Promise<void>((R, E) => {
                    const onMsg = (msg: any) => {
                        if (msg.type === "bound") {
                            this.transport!.removeListener("message", onMsg)
                            this.boundAddress = { address: msg.address, port: msg.port }
                            R()
                        } else if (msg.type === "bind-error") {
                            this.transport!.removeListener("message", onMsg)
                            E({ code: msg.code, message: msg.message })
                        }
                    }
                    this.transport!.on("message", onMsg)
                    this.transport!.postMessage({ type: "bind", port: listenPort, address: localIP.address })
                });
                return
            } catch (e) {
                if ((e as any)?.code !== "EADDRINUSE") throw e
                this.transport!.postMessage({ type: "rebind" })
                listenPort++
            }
        }

        throw new Error("Exhausted ports")
    }
    Destroy(cause?: any) {
        if (!this.destroyed) {
            this.destroyed = true;
            this.notify(TokenRingTestEvent.Destroyed, {
                issuer_id: this.issuer_id,
                cause: cause ? ((cause as any)?.message ?? String(cause)) : undefined,
            })
            if (cause) {
                this.log.error("Destroying TokenRing due to Error", cause)
                this.onError(cause)
            }
            else {
                this.log.log("Destroying TokenRing")
                this.onDestroy()
            }
            if (this.transport) {
                this.transport.removeAllListeners()
                this.transport.postMessage({ type: "close" })
                this.transport.terminate().catch(() => { })
                this.transport = null
            }
            // Wake the main loop if it's parked on waitForAToken so it can exit.
            const w = this.tokenWaiter
            this.tokenWaiter = undefined
            if (w) w.reject(new TokenTimeout())
            this.storage
                .doTn(async txn => {
                    txn.tokenRingRegistration.clear({
                        segment_name: this.args.segment_name,
                        server_ip: this.boundAddress.address,
                        server_port: this.boundAddress.port
                    })
                })
                .catch(e => this.log.error("Error during deregistration", e))
        }
    }
    protected async Register() {
        const key = {
            segment_name: this.args.segment_name,
            server_ip: this.boundAddress.address,
            server_port: this.boundAddress.port,
        }
        this.notify(TokenRingTestEvent.RegisterEnter, {
            issuer_id: this.issuer_id,
            key,
        })
        await this.storage.doTn(async txn => {
            const existing = await txn.tokenRingRegistration.get(key)
            txn.tokenRingRegistration.set(key, {
                // Spread preserves optional members the consumer may have added.
                // When existing is undefined (first write) the spread is a no-op;
                // Is the storage adapter uses invariant types we know that any additional props are optional
                ...existing,
                last_seen: Date.now(),
                executor_id: this.issuer_id,
            })
        })
        this.notify(TokenRingTestEvent.RegisterExit, {
            issuer_id: this.issuer_id,
            key,
        })
    }
    protected async RunRegistrationForever() {
        while (!this.destroyed) {
            try {
                await new Promise(R => setTimeout(R, this.server_reregister_time_ms).unref())
                await this.Register()
            } catch (e) {
                this.Destroy(e)
            }
        }
    }
    protected prefixes = {
        ACK: 1,
        TOKEN: 2
    }
    protected deserializeToken(buf: Buffer): Token {
        const prefix = buf[0];
        if (prefix !== this.prefixes.TOKEN) {
            throw new Error("Invalid token prefix")
        }
        buf = buf.subarray(1);
        const [issued_by, issuer_version, averageWorkload, server_count, capabilities, flags] = tuple.unpack(buf)
        //check types and structure of unpacked data
        if (typeof issued_by !== "string" || typeof issuer_version !== "number" || typeof averageWorkload !== "number" || typeof server_count !== "number" || !Buffer.isBuffer(capabilities) || typeof flags !== "number") {
            throw new Error("Invalid token format")
        }
        return {
            issued_by,
            issuer_version,
            averageWorkload,
            server_count,
            capabilities,
            flags
        }

    }
    protected serializeToken(token: Token): Buffer {
        //we'll use an fdb tuple pack for the binary format
        return Buffer.concat([this.tokenBuffer, tuple.pack([token.issued_by, token.issuer_version, token.averageWorkload, token.server_count, token.capabilities, token.flags])])
    }
    protected tokenBuffer = Buffer.alloc(1, this.prefixes.TOKEN)
    protected BindTransportEvents() {
        this.transport!.on("message", (msg: any) => {
            try {
                if (msg.type === "token") {
                    if (this.destroyed) return;
                    const token: Token = this.deserializeToken(Buffer.from(msg.data))
                    this.notify(TokenRingTestEvent.TransportTokenIn, {
                        issuer_id: this.issuer_id,
                        issued_by: token.issued_by,
                        issuer_version: token.issuer_version,
                        remoteAddress: msg.remoteAddress,
                        remotePort: msg.remotePort,
                        last_seen_by: this.last_seen_token.token.issued_by,
                        last_seen_version: this.last_seen_token.token.issuer_version,
                    })
                    // Own token completed a loop — clear provisional before enqueueing.
                    if (token.issued_by === this.issuer_id)
                        token.flags = token.flags & ~TokenFlags.provisional
                    this.enqueueToken(token)
                } else if (msg.type === "error") {
                    this.Destroy(new Error(msg.message))
                } else if (msg.type === "close") {
                    this.Destroy()
                }
            } catch (e) {
                this.log.error("received unparseable message")
            }
        })
    }

    private async GetNextServerInRing(txn: StorageTxn<TokenRingRegistrationKey, TokenRingRegistrationValue>): Promise<TokenRingRegistrationKey | null> {

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
    private async GetFirstServerInRing(txn: StorageTxn<TokenRingRegistrationKey, TokenRingRegistrationValue>): Promise<TokenRingRegistrationKey | null> {
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

    /**
     * Process a single token. Called exclusively from `runMainLoop`, so
     * `last_seen_token` cannot be mutated by anyone else during its body.
     * That guarantee is what removes the `PassOnSkippedStale` branch and
     * the entire concurrent-`TokenReceived` race.
     */
    protected async processToken(token: Token) {
        if (this.destroyed) return;
        const prev_seen_by = this.last_seen_token.token.issued_by
        const prev_seen_version = this.last_seen_token.token.issuer_version
        this.notify(TokenRingTestEvent.TokenReceivedEnter, {
            issuer_id: this.issuer_id,
            issued_by: token.issued_by,
            issuer_version: token.issuer_version,
            provisional: !!(token.flags & TokenFlags.provisional),
            prev_seen_by,
            prev_seen_version,
        })
        if (this.compareTokens(token, this.last_seen_token.token) > 0) {
            this.log.log("Adopting new token", token.issued_by, token.issuer_version)
            this.notify(TokenRingTestEvent.TokenAdopted, {
                issuer_id: this.issuer_id,
                issued_by: token.issued_by,
                issuer_version: token.issuer_version,
                prev_seen_by,
                prev_seen_version,
            })
        }
        try {
            if (token.issuer_version !== this.last_seen_token.token.issuer_version) {
                token.server_count++;
            }
            this.log.debug("Received token ", token)
            this.last_seen_token = { token, last_seen: Date.now() }
            //or my own capabilities into the token
            token.capabilities = mergeCapabilityBuffers(token.capabilities, this.args.capabilities)
            //do some work
            try {
                const workload = await new Promise<number>((R, E) => {
                    this.onToken({
                        ring: this,
                        token,
                        done: (workload) => {
                            R(workload.running)
                        },
                        error: E
                    })
                })
                this.last_seen_token.token.averageWorkload = (0.9 * this.last_seen_token.token.averageWorkload) + 0.1 * workload
            } catch (e) {
                this.log.error("Unhandled work handler error", e)
            }
            while (!this.destroyed) {
                let nextKey = await this.storage.doTn(async txn => await this.GetNextServerInRing(txn.tokenRingRegistration) || await this.GetFirstServerInRing(txn.tokenRingRegistration));
                if (!nextKey) {
                    throw new Error("No servers found in ring")
                }
                if (nextKey.server_ip === this.boundAddress.address && nextKey.server_port === this.boundAddress.port) {
                    //throttle if we are the only one at the party
                    await new Promise(R => setTimeout(R, 100).unref());
                }
                const new_token: Token = {
                    ...this.last_seen_token.token,
                }
                const isSelf = nextKey.server_ip === this.boundAddress.address && nextKey.server_port === this.boundAddress.port
                this.notify(TokenRingTestEvent.PassOnSent, {
                    issuer_id: this.issuer_id,
                    issued_by: new_token.issued_by,
                    issuer_version: new_token.issuer_version,
                    target_ip: nextKey.server_ip,
                    target_port: nextKey.server_port,
                    isSelf,
                })
                const ackResult = await new Promise<"ok" | "timeout">((R) => {
                    if (this.destroyed || !this.transport) { R("timeout"); return }
                    const transport = this.transport
                    const onMsg = (msg: any) => {
                        if (msg.type === "ack-ok") {
                            transport.removeListener("message", onMsg)
                            R("ok")
                        } else if (msg.type === "ack-timeout") {
                            transport.removeListener("message", onMsg)
                            R("timeout")
                        }
                    }
                    transport.on("message", onMsg)
                    this.log.debug("sending to", nextKey.server_port, nextKey.server_ip)
                    transport.postMessage({
                        type: "send",
                        data: this.serializeToken(new_token),
                        port: nextKey.server_port,
                        address: nextKey.server_ip,
                        awaitAck: {
                            ip: nextKey.server_ip,
                            port: nextKey.server_port,
                            timeoutMs: this.args.config.token_ack_timeout_ms,
                        }
                    })
                })

                if (!this.destroyed && ackResult === "timeout" && !isSelf) {
                    //our passed on token was never acked!!
                    this.log.warn("Removing unresponsive server", nextKey)
                    this.notify(TokenRingTestEvent.PassOnAckTimeout, {
                        issuer_id: this.issuer_id,
                        target_ip: nextKey.server_ip,
                        target_port: nextKey.server_port,
                    })
                    this.MarkServerAsUnresponsive(nextKey)
                        .catch(e => this.log.error("Error marking server as unresponsive", e))
                } else {
                    if (ackResult === "ok") this.notify(TokenRingTestEvent.PassOnAckOk, {
                        issuer_id: this.issuer_id,
                        target_ip: nextKey.server_ip,
                        target_port: nextKey.server_port,
                    })
                    break
                }
            }
        } catch (e) {
            this.log.error(e);
            throw e;
        }
        this.notify(TokenRingTestEvent.TokenReceivedExit, {
            issuer_id: this.issuer_id,
            issued_by: token.issued_by,
            issuer_version: token.issuer_version,
        })
    }
    protected async MarkServerAsUnresponsive(key: TokenRingRegistrationKey) {
        const value = await this.storage.doTn(async txn => {
            const value = await txn.tokenRingRegistration.get(key);
            if (value) {
                txn.tokenRingRegistration.clear(key)
            }
            return value

        })
        if (!value) return; //already gone, maybe by another server that also noticed the issue
        this.notify(TokenRingTestEvent.ServerMarkedUnresponsive, {
            issuer_id: this.issuer_id,
            dead_ip: key.server_ip,
            dead_port: key.server_port,
            dead_executor_id: value.executor_id,
        })
        //notify the consumer to handle orphaned job cleanup
        await this.onServerUnresponsive({ key, value })
    }

    abstract onToken(ctx: {
        ring: TokenRingWorkDistributorInterface
        token: Readonly<Token>
        done: (workload: { running: number }) => void
        error: (e: any) => void
    }): void
    /**
 * Called when the token ring detects that a server is unresponsive
 * (failed to ACK a forwarded token). The ring has already removed 
 * the dead server's registration. The consumer is responsible for 
 * any cleanup (e.g. resetting orphaned jobs).
 */

    onServerUnresponsive(registration: {
        key: TokenRingRegistrationKey
        value: TokenRingRegistrationValue
    }): void | Promise<void> {
        //no-op by default, consumer can override to handle cleanup of orphaned jobs, etc.
        console.warn("Server unresponsive", JSON.stringify(registration))
    }
    onError(e: any): void {
        //no-op by default, consumer can override to handle errors
        console.error("TokenRing error", e)
    }
    onDestroy(): void {
        //no-op by default, consumer can override to handle destruction
        console.log("TokenRing destroyed")
    }
    /**
     * Optional: override local IP/interface discovery.
     * If the transport provides `getLocalAddress()` it is used first.
     * Otherwise falls back to finding the first non-internal IPv4 interface matching /^e.*0$/ (eth0, en0, etc.)
     */
    getLocalAddress(): { address: string } {
        if (this.transport?.getLocalAddress) return this.transport.getLocalAddress()
        console.log("Discovering local IP address using default method. Override getLocalAddress() to customize this behaviour.")
        const interfaces = os.networkInterfaces()
        const flatInterfaces = Object.keys(interfaces).map(k => interfaces[k]?.map(i => ({ name: k, ...i })) || []).flatMap(v => v)
            .filter(v => !v.internal && (v.family == "IPv4" || (v.family as any) === 4))
        const eth0 = flatInterfaces.find(v => !!v.name.match(/^e.*0$/))
        if (eth0)
            return eth0
        throw new Error("Unable to determine local ip of eth0")
    }
}