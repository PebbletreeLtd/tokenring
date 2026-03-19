/**
 * In-memory transport that implements the same message protocol as the
 * UDP worker thread, but without real sockets.
 *
 * Useful for fast, deterministic tests and upstream integration testing.
 *
 * Usage:
 *   class TestRing extends TokenRingWorkDistributor {
 *       protected createTransport() { return new InMemoryTransport() }
 *   }
 *
 * Call `InMemoryTransport.clearRegistry()` between tests to avoid stale
 * bindings from previous runs.
 */

import { TokenRingTransport } from "./tokenRingTypes"

type MessageHandler = (msg: any) => void

export class InMemoryTransport implements TokenRingTransport {
    /** Global registry of bound transports keyed by "address:port" */
    private static registry = new Map<string, InMemoryTransport>()

    private listeners: MessageHandler[] = []
    private boundAddress: string | null = null
    private boundPort: number | null = null
    private closed = false

    private static key(address: string, port: number) {
        return `${address}:${port}`
    }

    getLocalAddress(): { address: string } {
        return { address: "127.0.0.1" }
    }

    on(_event: "message", handler: MessageHandler): void {
        this.listeners.push(handler)
    }

    removeListener(_event: "message", handler: MessageHandler): void {
        const idx = this.listeners.indexOf(handler)
        if (idx !== -1) this.listeners.splice(idx, 1)
    }

    removeAllListeners(): void {
        this.listeners = []
    }

    /** Emit a message to all current listeners asynchronously (mirrors worker thread delivery). */
    private emit(msg: any) {
        const snapshot = [...this.listeners]
        setTimeout(() => {
            for (const h of snapshot) h(msg)
        }, 0)
    }

    postMessage(msg: any): void {
        if (this.closed) return

        switch (msg.type) {
            case "bind": {
                const key = InMemoryTransport.key(msg.address, msg.port)
                if (InMemoryTransport.registry.has(key)) {
                    this.emit({ type: "bind-error", code: "EADDRINUSE", message: `Port ${msg.port} in use` })
                } else {
                    InMemoryTransport.registry.set(key, this)
                    this.boundAddress = msg.address
                    this.boundPort = msg.port
                    this.emit({ type: "bound", address: msg.address, port: msg.port })
                }
                break
            }

            case "send": {
                const targetKey = InMemoryTransport.key(msg.address, msg.port)
                const target = InMemoryTransport.registry.get(targetKey)

                if (target && !target.closed) {
                    const tokenData = Buffer.from(msg.data)
                    const senderAddress = this.boundAddress
                    const senderPort = this.boundPort
                    const awaitAck = msg.awaitAck
                    const sender = this

                    // Simulate network delivery — deliver token to target, then ACK to sender
                    setTimeout(() => {
                        if (target.closed) {
                            // Target closed between send and delivery — timeout
                            if (awaitAck && !sender.closed) {
                                for (const h of [...sender.listeners]) h({ type: "ack-timeout" })
                            }
                            return
                        }

                        // Target receives the token
                        for (const h of [...target.listeners]) h({
                            type: "token",
                            data: tokenData,
                            remoteAddress: senderAddress,
                            remotePort: senderPort,
                        })

                        // ACK comes back to sender
                        if (awaitAck && !sender.closed) {
                            for (const h of [...sender.listeners]) h({ type: "ack-ok" })
                        }
                    }, 0)
                } else if (msg.awaitAck) {
                    const timeoutMs = msg.awaitAck.timeoutMs
                    const sender = this
                    // Target not found or closed — timeout after the configured delay
                    setTimeout(() => {
                        if (sender.closed) return
                        for (const h of [...sender.listeners]) h({ type: "ack-timeout" })
                    }, timeoutMs)
                }
                break
            }

            case "rebind": {
                // Unbind from registry for port retry
                if (this.boundAddress !== null && this.boundPort !== null) {
                    InMemoryTransport.registry.delete(
                        InMemoryTransport.key(this.boundAddress, this.boundPort)
                    )
                }
                this.boundAddress = null
                this.boundPort = null
                break
            }

            case "close": {
                this.closed = true
                if (this.boundAddress !== null && this.boundPort !== null) {
                    InMemoryTransport.registry.delete(
                        InMemoryTransport.key(this.boundAddress, this.boundPort)
                    )
                }
                this.emit({ type: "close" })
                break
            }
        }
    }

    async terminate(): Promise<number> {
        this.closed = true
        if (this.boundAddress !== null && this.boundPort !== null) {
            InMemoryTransport.registry.delete(
                InMemoryTransport.key(this.boundAddress, this.boundPort)
            )
        }
        this.removeAllListeners()
        return 0
    }

    /** Clear the global registry — call between tests to avoid stale bindings. */
    static clearRegistry() {
        InMemoryTransport.registry.clear()
    }
}
