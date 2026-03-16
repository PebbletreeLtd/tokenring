/**
 * UDP Socket Worker Thread
 * 
 * Owns the dgram socket in its own event loop so that ACK responses
 * are sent immediately regardless of main-thread load.
 * 
 * Protocol:
 *   Main → Worker:
 *     { type: "bind", port, address }
 *     { type: "send", data: Buffer, port, address, awaitAck?: { ip: string, port: number, timeoutMs: number } }
 *     { type: "close" }
 * 
 *   Worker → Main:
 *     { type: "bound", address, port }
 *     { type: "bind-error", code, message }
 *     { type: "token", data: Buffer, remoteAddress, remotePort }
 *     { type: "ack-ok" }
 *     { type: "ack-timeout" }
 *     { type: "error", message }
 *     { type: "close" }
 */

import { parentPort } from "worker_threads"
import * as dgram from "dgram"

const ACK_PREFIX = 1
const TOKEN_PREFIX = 2
const ackBuffer = Buffer.alloc(1, ACK_PREFIX)

let socket = dgram.createSocket("udp4")
let pendingAckResolve: ((rinfo: dgram.RemoteInfo) => void) | null = null

function setupSocket() {
    socket.on("message", (msg, remote) => {
        if (msg[0] === ACK_PREFIX) {
            // ACK received — resolve any pending ack wait
            pendingAckResolve?.(remote)
            return
        }

        if (msg[0] === TOKEN_PREFIX) {
            // Immediately ACK the sender — this is the whole point of the worker
            socket.send(ackBuffer, remote.port, remote.address)

            // Forward the raw token data to main thread for processing
            parentPort!.postMessage({
                type: "token",
                data: msg,
                remoteAddress: remote.address,
                remotePort: remote.port,
            })
        }
    })

    socket.on("error", (e) => {
        parentPort!.postMessage({ type: "error", message: (e as Error).message })
    })

    socket.on("close", () => {
        parentPort!.postMessage({ type: "close" })
    })
}

setupSocket()

parentPort!.on("message", (msg) => {
    switch (msg.type) {
        case "bind": {
            try {
                socket.bind(msg.port, msg.address)
            } catch (e) {
                parentPort!.postMessage({ type: "bind-error", code: (e as any)?.code, message: (e as Error).message })
                return
            }
            socket.once("listening", () => {
                const addr = socket.address()
                parentPort!.postMessage({ type: "bound", address: addr.address, port: addr.port })
            })
            socket.once("error", (e) => {
                parentPort!.postMessage({ type: "bind-error", code: (e as any)?.code, message: (e as Error).message })
            })
            break
        }

        case "send": {
            const data = Buffer.from(msg.data)
            socket.send(data, msg.port, msg.address)

            if (msg.awaitAck) {
                const { ip, port: ackPort, timeoutMs } = msg.awaitAck

                const timeout = setTimeout(() => {
                    pendingAckResolve = null
                    parentPort!.postMessage({ type: "ack-timeout" })
                }, timeoutMs)

                pendingAckResolve = (rinfo) => {
                    if (rinfo.address === ip && rinfo.port === ackPort) {
                        clearTimeout(timeout)
                        pendingAckResolve = null
                        parentPort!.postMessage({ type: "ack-ok" })
                    }
                }
            }
            break
        }

        case "rebind": {
            // Create a fresh socket for port retry
            socket = dgram.createSocket("udp4")
            setupSocket()
            break
        }

        case "close": {
            pendingAckResolve = null
            try { socket.close() } catch (_) { /* already closed */ }
            break
        }
    }
})
