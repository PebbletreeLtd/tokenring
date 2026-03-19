import * as os from "os"
import * as path from "path"
import * as fs from "fs"
import { Worker } from "worker_threads"
import tuple from "fdb-tuple"
import {
    Token, TokenFlags,
    TokenRingRegistrationKey,
    TokenRingOptions,
    TokenRingConfig,
    TokenRingWorkDistributorInterface,
    TokenRingRegistrationValue,
    TokenRingTransport,
} from "./tokenRingTypes"
import { MVCCCore } from "@pebbletree/mvcc-testing"

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
    protected token_timer: any = undefined
    protected transport: TokenRingTransport | null = null
    protected boundAddress: { address: string, port: number } = { address: "", port: 0 }
    protected averageLoopDuration = process.platform === "darwin" ? 2500 : 30000
    protected readonly server_reregister_time_ms
    protected destroyed: boolean = false
    readonly segmentName
    readonly doTn;
    readonly config: Readonly<TokenRingConfig>
    protected readonly log: Logger
    constructor(protected args: TokenRingOptions) {
        this.config = args.config
        this.log = createLogger(!!args.config.verbose)
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
        this.doTn = args.doTn
    }
    get Token() {
        return this.last_seen_token.token
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
            this.startLostTokenTimer()
            this.RunRegistrationForever()
        } catch (e) {
            this.log.error("WorkflowInstance.Start", e)
            throw e;
        }
        return this
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
            if (this.token_timer) clearTimeout(this.token_timer);
            this.doTn(async txn => {
                return txn.clear({
                    segment_name: this.args.segment_name,
                    server_ip: this.boundAddress.address,
                    server_port: this.boundAddress.port
                })
            }).catch(e => this.log.error("Error during deregistration", e))
        }
    }
    protected async Register() {
        const key = {
            segment_name: this.args.segment_name,
            server_ip: this.boundAddress.address,
            server_port: this.boundAddress.port,
        }
        await this.doTn(async txn => {
            const existing = await txn.get(key)
            txn.set(key, {
                // Spread preserves optional members the consumer may have added.
                // When existing is undefined (first write) the spread is a no-op;
                // Is the storage adapter uses invariant types we know that any additional props are optional
                ...existing,
                last_seen: Date.now(),
                executor_id: this.issuer_id,
            })
        })
    }
    protected async RunRegistrationForever() {
        while (!this.destroyed) {
            try {
                await new Promise(R => setTimeout(R, this.server_reregister_time_ms))
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
        this.transport!.on("message", async (msg: any) => {
            try {
                if (msg.type === "token") {
                    if (this.destroyed) return;
                    const token: Token = this.deserializeToken(Buffer.from(msg.data))
                    if (token.issued_by < this.last_seen_token.token.issued_by
                        || (token.issued_by === this.last_seen_token.token.issued_by
                            && token.issuer_version < this.last_seen_token.token.issuer_version)) {
                        this.log.log("Dropping duplicate token", token.issued_by, token.issuer_version)
                        return;
                    }
                    if (token.issued_by > this.last_seen_token.token.issued_by
                        || (token.issued_by === this.last_seen_token.token.issued_by
                            && token.issuer_version > this.last_seen_token.token.issuer_version)) {
                        this.log.log("Adopting new token", token.issued_by, token.issuer_version)
                    }

                    const lastSeen = this.last_seen_token.last_seen
                    try {
                        if (token.issued_by === this.issuer_id)
                            token.flags = token.flags & ~TokenFlags.provisional //if we issued the token, it's not provisional anymore
                        await this.TokenReceived(token)
                    } catch (e) {
                        this.Destroy(e)
                    }

                    if (lastSeen !== 0) {
                        let loopDuration = Date.now() - lastSeen
                        if (loopDuration < 500) {
                            //hold up tokens which are madly spinning round. Maybe I'm the only server
                            await new Promise(R => setTimeout(R, 500 - loopDuration))
                            loopDuration = Date.now() - lastSeen
                        }
                        const alpha = 0.1
                        this.averageLoopDuration = alpha * loopDuration + (1 - alpha) * this.averageLoopDuration
                    }
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

    private async GetNextServerInRing(txn: MVCCCore.ITransaction<TokenRingRegistrationKey, TokenRingRegistrationKey, TokenRingRegistrationValue, TokenRingRegistrationValue>): Promise<TokenRingRegistrationKey | null> {

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
    private async GetFirstServerInRing(txn: MVCCCore.ITransaction<TokenRingRegistrationKey, TokenRingRegistrationKey, TokenRingRegistrationValue, TokenRingRegistrationValue>): Promise<TokenRingRegistrationKey | null> {
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

    protected async TokenReceived(token: Token) {
        if (this.destroyed) return;
        try {
            if (token.issuer_version !== this.last_seen_token.token.issuer_version) {
                token.server_count++;
            }
            this.log.debug("Received token ", token)
            this.last_seen_token = { token, last_seen: Date.now() }
            //or my own capabilities into the token
            token.capabilities = mergeCapabilityBuffers(token.capabilities, this.args.capabilities)
            this.startLostTokenTimer()
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
                let nextKey = await this.doTn(async txn => await this.GetNextServerInRing(txn) || await this.GetFirstServerInRing(txn));
                if (!nextKey) {
                    throw new Error("No servers found in ring")
                }
                if (nextKey.server_ip === this.boundAddress.address && nextKey.server_port === this.boundAddress.port) {
                    //throttle if we are the only one at the party
                    await new Promise(R => setTimeout(R, 100));
                }
                //pass the token on, if we still hold the same token
                if (this.last_seen_token.token.issued_by === token.issued_by && this.last_seen_token.token.issuer_version === token.issuer_version) {
                    const new_token: Token = {
                        ...this.last_seen_token.token,
                    }
                    const isSelf = nextKey.server_ip === this.boundAddress.address && nextKey.server_port === this.boundAddress.port
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
                        this.MarkServerAsUnresponsive(nextKey)
                            .catch(e => this.log.error("Error marking server as unresponsive", e))
                    } else {
                        break
                    }
                } else {
                    break;
                }
            }
        } catch (e) {
            this.log.error(e);
            throw e;
        }
    }
    protected async MarkServerAsUnresponsive(key: TokenRingRegistrationKey) {
        const value = await this.doTn(async txn => {
            const value = await txn.get(key);
            if (value) {
                txn.clear(key)
            }
            return value

        })
        if (!value) return; //already gone, maybe by another server that also noticed the issue
        //notify the consumer to handle orphaned job cleanup
        await this.onServerUnresponsive({ key, value })
    }

    protected _everLoaded = false;
    protected startLostTokenTimer() {
        if (this.token_timer) clearTimeout(this.token_timer)
        if (this.destroyed) return
        const timeout = this.args.config.skipInitialTokenTimeout && !this._everLoaded
            ? 0
            : Math.max(this.averageLoopDuration * 3, 2000)
        this.log.debug("Waiting for", timeout, " before timing token out")
        this.token_timer = setTimeout(() => {
            if (this.destroyed) return
            if (!this.args.config.skipInitialTokenTimeout || this._everLoaded)
                this.log.warn(`Token receive timeout ${this.segmentName}`)
            this._everLoaded = true;
            //issue a new token, force it to be sent, even if the issued by isn't higher
            this.TokenReceived({
                issued_by: this.issuer_id,
                server_count: 0,
                issuer_version: ++this.issuer_version,
                averageWorkload: this.last_seen_token.token.averageWorkload,
                capabilities: this.args.capabilities,
                flags: TokenFlags.provisional
            }).catch(() => this.Destroy())
        }, timeout)
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
     * Defaults to finding the first non-internal IPv4 interface matching /^e.*0$/ (eth0, en0, etc.)
     */
    getLocalAddress(): { address: string } {
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