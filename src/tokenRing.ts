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


function defaultDetermineLocalIP(): { address: string } {
    const interfaces = os.networkInterfaces()
    const flatInterfaces = Object.keys(interfaces).map(k => interfaces[k]?.map(i => ({ name: k, ...i })) || []).flatMap(v => v)
        .filter(v => !v.internal && (v.family == "IPv4" || (v.family as any) === 4))
    const eth0 = flatInterfaces.find(v => !!v.name.match(/^e.*0$/))
    if (eth0)
        return eth0
    throw new Error("Unable to determine local ip of eth0")
}

export class TokenRingWorkDistributor implements TokenRingWorkDistributorInterface {
    readonly issuer_id;
    private issuer_version = 1
    last_seen_token: { token: Token, last_seen: number }
    private token_timer: any = undefined
    private worker: Worker | null = null
    private boundAddress: { address: string, port: number } = { address: "", port: 0 }
    private averageLoopDuration = process.platform === "darwin" ? 2500 : 30000
    private readonly server_reregister_time_ms
    private destroyed: boolean = false
    readonly segmentName

    readonly config: Readonly<TokenRingConfig>
    private readonly log: Logger
    constructor(private options: TokenRingOptions) {
        this.config = options.config
        this.log = createLogger(!!options.config.verbose)
        this.issuer_id = options.issuer_id
        this.server_reregister_time_ms = options.config.reregister_time_ms
        this.segmentName = options.segment_name
        this.last_seen_token = {
            last_seen: 0,
            token: {
                averageWorkload: 0,
                issued_by: "",
                issuer_version: 0,
                server_count: 0,
                capabilities: this.options.capabilities,
                flags: TokenFlags.provisional
            }
        }
    }
    get Token() {
        return this.last_seen_token.token
    }

    async Start() {
        try {
            this.worker = new Worker(path.join(ProjectRoot, "dist", "src", "udpWorker.js"))
            await this.Listen()
            this.BindWorkerEvents()
            await this.Register()
            this.startLostTokenTimer()
            this.RunRegistrationForever()
        } catch (e) {
            this.log.error("WorkflowInstance.Start", e)
            throw e;
        }
        return this
    }

    private async Listen() {
        let listenPort = 5000;
        const localIP = (this.options.getLocalAddress ?? defaultDetermineLocalIP)()
        while (listenPort < 65536) {
            try {
                await new Promise<void>((R, E) => {
                    const onMsg = (msg: any) => {
                        if (msg.type === "bound") {
                            this.worker!.removeListener("message", onMsg)
                            this.boundAddress = { address: msg.address, port: msg.port }
                            R()
                        } else if (msg.type === "bind-error") {
                            this.worker!.removeListener("message", onMsg)
                            E({ code: msg.code, message: msg.message })
                        }
                    }
                    this.worker!.on("message", onMsg)
                    this.worker!.postMessage({ type: "bind", port: listenPort, address: localIP.address })
                });
                return
            } catch (e) {
                if ((e as any)?.code !== "EADDRINUSE") throw e
                this.worker!.postMessage({ type: "rebind" })
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
                this.options.onError?.(cause)
            }
            else {
                this.log.log("Destroying TokenRing")
                this.options.onDestroy?.()
            }
            if (this.worker) {
                this.worker.removeAllListeners()
                this.worker.postMessage({ type: "close" })
                this.worker.terminate().catch(() => { })
                this.worker = null
            }
            if (this.token_timer) clearTimeout(this.token_timer)
            const deregisterResult = this.options.storage.deregister({
                segment_name: this.options.segment_name,
                server_ip: this.boundAddress.address,
                server_port: this.boundAddress.port
            })
            if (deregisterResult instanceof Promise) {
                deregisterResult.catch(e => this.log.error(e))
            }
        }
    }
    private async Register() {
        await this.options.storage.register(
            { segment_name: this.options.segment_name, server_ip: this.boundAddress.address, server_port: this.boundAddress.port },
            { last_seen: Date.now(), executor_id: this.issuer_id }
        )
    }
    private async RunRegistrationForever() {
        while (!this.destroyed) {
            try {
                await new Promise(R => setTimeout(R, this.server_reregister_time_ms))
                await this.Register()
            } catch (e) {
                this.Destroy(e)
            }
        }
    }
    private prefixes = {
        ACK: 1,
        TOKEN: 2
    }
    private deserializeToken(buf: Buffer): Token {
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
    private serializeToken(token: Token): Buffer {
        //we'll use an fdb tuple pack for the binary format
        return Buffer.concat([this.tokenBuffer, tuple.pack([token.issued_by, token.issuer_version, token.averageWorkload, token.server_count, token.capabilities, token.flags])])
    }
    private tokenBuffer = Buffer.alloc(1, this.prefixes.TOKEN)
    private BindWorkerEvents() {
        this.worker!.on("message", async (msg: any) => {
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
    private async GetNextServerInRing() {
        const candidateKey = await this.options.storage.getNextInRing(
            { segment_name: this.options.segment_name, server_ip: this.boundAddress.address, server_port: this.boundAddress.port },
            this.options.segment_name
        )
        if (!candidateKey) {
            throw new Error("Unexpected condition, no servers in cluster (expected at least me)")
        }
        return candidateKey
    }
    private async TokenReceived(token: Token) {
        if (this.destroyed) return;
        try {
            if (token.issuer_version !== this.last_seen_token.token.issuer_version) {
                token.server_count++;
            }
            this.log.debug("Received token ", token)
            this.last_seen_token = { token, last_seen: Date.now() }
            //or my own capabilities into the token
            token.capabilities = mergeCapabilityBuffers(token.capabilities, this.options.capabilities)
            this.startLostTokenTimer()
            //do some work
            try {
                const workload = await new Promise<number>((R, E) => {
                    this.options.onToken({
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
                let nextKey = await this.GetNextServerInRing();
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
                        if (this.destroyed || !this.worker) { R("timeout"); return }
                        const worker = this.worker
                        const onMsg = (msg: any) => {
                            if (msg.type === "ack-ok") {
                                worker.removeListener("message", onMsg)
                                R("ok")
                            } else if (msg.type === "ack-timeout") {
                                worker.removeListener("message", onMsg)
                                R("timeout")
                            }
                        }
                        worker.on("message", onMsg)
                        this.log.debug("sending to", nextKey.server_port, nextKey.server_ip)
                        worker.postMessage({
                            type: "send",
                            data: this.serializeToken(new_token),
                            port: nextKey.server_port,
                            address: nextKey.server_ip,
                            awaitAck: {
                                ip: nextKey.server_ip,
                                port: nextKey.server_port,
                                timeoutMs: this.options.config.token_ack_timeout_ms,
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
    private async MarkServerAsUnresponsive(key: TokenRingRegistrationKey) {
        const value = await this.options.storage.removeRegistration(key)
        if (!value) return; //already gone, maybe by another server that also noticed the issue
        //notify the consumer to handle orphaned job cleanup
        await this.options.onServerUnresponsive?.({ key, value })
    }

    private _everLoaded = false;
    private startLostTokenTimer() {
        if (this.token_timer) clearTimeout(this.token_timer)
        if (this.destroyed) return
        const timeout = this.options.config.skipInitialTokenTimeout && !this._everLoaded
            ? 0
            : Math.max(this.averageLoopDuration * 3, 2000)
        this.log.debug("Waiting for", timeout, " before timing token out")
        this.token_timer = setTimeout(() => {
            if (this.destroyed) return
            if (!this.options.config.skipInitialTokenTimeout || this._everLoaded)
                this.log.warn(`Token receive timeout ${this.segmentName}`)
            this._everLoaded = true;
            //issue a new token, force it to be sent, even if the issued by isn't higher
            this.TokenReceived({
                issued_by: this.issuer_id,
                server_count: 0,
                issuer_version: ++this.issuer_version,
                averageWorkload: this.last_seen_token.token.averageWorkload,
                capabilities: this.options.capabilities,
                flags: TokenFlags.provisional
            }).catch(() => this.Destroy())
        }, timeout)
    }
}