# @pebbletree/tokenring

Distributed token ring over UDP for coordinating work across a cluster of servers.

## Overview

A single token circulates around a ring of servers via UDP. When a server receives the token it gets an `onToken` callback — this is the place to pick up and start work. Because only one server holds the token at any moment, the ring provides a lightweight form of distributed mutual exclusion without requiring a central lock server.

Key properties of the ring:

- **Automatic membership** — servers register themselves in a storage backend you provide and are discovered by peers automatically.
- **Capability merging** — each server declares a capabilities bitmask. As the token travels the ring, capabilities are merged (bitwise OR) so every server learns the aggregate capabilities of the cluster.
- **Failure detection** — if a server fails to ACK a forwarded token within the configured timeout, it is removed from the ring and the consumer is notified via `onServerUnresponsive` for cleanup (e.g. resetting orphaned jobs).
- **Dedicated UDP worker thread** — the UDP socket runs in a separate `worker_threads` thread, so ACKs are sent and received immediately regardless of main-thread load. This prevents false evictions when the application's event loop is busy with `onToken` work or other processing.
- **Pluggable transport** — the UDP worker is hidden behind a `TokenRingTransport` interface. Override `createTransport()` to swap in `InMemoryTransport` for fast, deterministic tests without real sockets.
- **Lost-token recovery** — if no token arrives within an adaptive timeout, a new provisional token is issued automatically.
- **Workload tracking** — each server reports its workload when releasing the token. An exponentially-weighted average is carried on the token for load-aware scheduling decisions.
- **Value preservation** — re-registration uses read-modify-write, so any extra optional fields your storage backend adds to the registration value are preserved across heartbeats.

## Installation

```bash
npm install @pebbletree/tokenring
```

## Architecture

`TokenRingWorkDistributor` is an abstract class. You subclass it to implement your token handler and optionally override lifecycle hooks. Storage is provided via a `TransactionFactory` passed in the constructor options — the base class owns the entire ring protocol including ring traversal, UDP transport, token serialisation, membership heartbeats, failure detection, and lost-token recovery.

### Abstract methods

| Method | Purpose |
| --- | --- |
| `onToken(ctx)` | Called each time the token arrives — do work, then call `ctx.done({ running })` |

### Overridable methods (with defaults)

| Method | Default behaviour |
| --- | --- |
| `onServerUnresponsive(registration)` | Logs a warning. Override to clean up orphaned work from evicted servers. |
| `onError(e)` | Logs the error. Override for custom error handling. |
| `onDestroy()` | Logs destruction. Override for graceful shutdown hooks. |
| `getLocalAddress()` | Defers to the transport's `getLocalAddress()` if present (e.g. `InMemoryTransport` returns `127.0.0.1`). Otherwise discovers the first non-internal IPv4 interface matching `/^e.*0$/` (eth0, en0, etc.). Override to control which interface/IP the ring binds to. |
| `createTransport()` | Returns a real `worker_threads` Worker running the UDP socket. Override to return `InMemoryTransport` for testing. |

## Quick start

```ts
import { TokenRingWorkDistributor } from "@pebbletree/tokenring"

// 1. Subclass and implement onToken
class MyTokenRing extends TokenRingWorkDistributor {

  onToken({ token, done }) {
    // Do work while holding the token
    done({ running: currentJobCount })
  }

  onServerUnresponsive({ key, value }) {
    // Clean up orphaned work from the dead server
  }
}

// 2. Create with your storage factory and start
const ring = await new MyTokenRing({
  segment_name: "my-segment",
  capabilities: Buffer.from([0x01]),
  issuer_id: "unique-server-id",
  config: {
    reregister_time_ms: 30_000,
    token_ack_timeout_ms: 1_000,
  },
  doTn: myStore.doTransaction.bind(myStore),
}).Start()

// Graceful shutdown
ring.Destroy()
```

## Constructor options (`TokenRingOptions`)

| Option | Required | Description |
| --- | --- | --- |
| `segment_name` | yes | Ring segment this server belongs to |
| `capabilities` | yes | `Buffer` bitmask of capabilities this server provides |
| `issuer_id` | yes | Unique identifier for this server |
| `config` | yes | See [Configuration](#configuration) |
| `doTn` | yes | A `TransactionFactory<TokenRingRegistrationKey, TokenRingRegistrationValue>` for transactional access to the membership table |

## Configuration

| Option | Description |
| --- | --- |
| `reregister_time_ms` | How often to re-register in the membership table (heartbeat) |
| `token_ack_timeout_ms` | How long to wait for a UDP ACK before marking a server as unresponsive |
| `skipInitialTokenTimeout` | Skip the initial lost-token timeout and suppress the first timeout warning |
| `verbose` | Enable debug/info logging to console. Errors are always logged. Defaults to `false`. |

## Capabilities

Capabilities are a `Buffer` bitmask. Each bit position represents a capability your application defines. As the token circulates, every server's capabilities are OR'd together, so the token always reflects the full set of capabilities present in the ring.

## API

### `TokenRingWorkDistributor`

- **`Start()`** — bind the UDP socket, register in the membership table, and begin participating in the ring. Returns a promise that resolves to the instance.
- **`Destroy(cause?)`** — leave the ring, close the socket, and deregister. If `cause` is provided, `onError` is called; otherwise `onDestroy` is called.
- **`Token`** — the most recently seen token (read-only).
- **`issuer_id`** — this server's unique identifier.
- **`segmentName`** — the ring segment this server belongs to.
- **`config`** — the active configuration (read-only).
- **`last_seen_token`** — the last seen token and the timestamp it was received.

### `onToken` callback

Called each time the token arrives at this server. Call `done({ running })` to release the token and report your current workload. Call `error(e)` to signal a fatal error.

### `onServerUnresponsive` callback

Called after the ring evicts an unresponsive server. The registration has already been removed from the membership table. Use this to clean up any work that was assigned to the dead server.

## Value preservation

The ring's re-registration uses a read-modify-write pattern: it reads the existing registration, spreads it, then overwrites only `last_seen` and `executor_id`. This means any additional optional fields your storage backend places on the registration value are preserved across heartbeats — the library will never clobber data it doesn't own.

## Testing

```bash
npm test
```

Tests use [vitest](https://vitest.dev/) and run against both transport modes by default:

- **memory** — uses `InMemoryTransport` (no real sockets, fast and deterministic)
- **udp** — uses real UDP sockets on localhost via a `worker_threads` Worker

To run only one mode:

```bash
TOKEN_RING_TRANSPORT=memory npm test
TOKEN_RING_TRANSPORT=udp npm test
```

### In-memory transport

`InMemoryTransport` is exported from the package and implements the same message protocol as the UDP worker thread, but routes messages through a shared in-process registry instead of real sockets. It is useful for upstream integration tests where spinning up real UDP sockets is unnecessary or undesirable.

```ts
import { InMemoryTransport, TokenRingWorkDistributor } from "@pebbletree/tokenring"

class TestRing extends TokenRingWorkDistributor {
  protected createTransport() { return new InMemoryTransport() }

  onToken({ done }) {
    done({ running: 0 })
  }
}
```

Call `InMemoryTransport.clearRegistry()` between tests to avoid stale port bindings.

## License

ISC
