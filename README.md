# @pebbletree/tokenring

Distributed token ring over UDP for coordinating work across a cluster of servers.

## Overview

A single token circulates around a ring of servers via UDP. When a server receives the token it gets an `onToken` callback — this is the place to pick up and start work. Because only one server holds the token at any moment, the ring provides a lightweight form of distributed mutual exclusion without requiring a central lock server.

Key properties of the ring:

- **Automatic membership** — servers register themselves in a pluggable storage backend and are discovered by peers automatically.
- **Capability merging** — each server declares a capabilities bitmask. As the token travels the ring, capabilities are merged (bitwise OR) so every server learns the aggregate capabilities of the cluster.
- **Failure detection** — if a server fails to ACK a forwarded token within the configured timeout, it is removed from the ring and the consumer is notified via `onServerUnresponsive` for cleanup (e.g. resetting orphaned jobs).
- **Dedicated UDP worker thread** — the UDP socket runs in a separate `worker_threads` thread, so ACKs are sent and received immediately regardless of main-thread load. This prevents false evictions when the application's event loop is busy with `onToken` work or other processing.
- **Lost-token recovery** — if no token arrives within an adaptive timeout, a new provisional token is issued automatically.
- **Workload tracking** — each server reports its workload when releasing the token. An exponentially-weighted average is carried on the token for load-aware scheduling decisions.

## Installation

```bash
npm install @pebbletree/tokenring
```

## Quick start

```ts
import { TokenRingWorkDistributor } from "@pebbletree/tokenring"

const ring = await new TokenRingWorkDistributor({
  segment_name: "my-segment",
  capabilities: Buffer.from([0x01]),
  issuer_id: "unique-server-id",
  config: {
    reregister_time_ms: 30_000,
    token_ack_timeout_ms: 1_000,
  },
  storage: myStorageAdapter, // implements TokenRingStorageAdapter
  onToken: ({ token, done }) => {
    // Do work while holding the token
    done({ running: currentJobCount })
  },
  onServerUnresponsive: ({ key, value }) => {
    // Clean up orphaned work from the dead server
  },
}).Start()

// Graceful shutdown
ring.Destroy()
```

## Constructor options

| Option                  | Required | Description                                                                                     |
| ----------------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `segment_name`          | yes      | Ring segment this server belongs to                                                             |
| `capabilities`          | yes      | `Buffer` bitmask of capabilities this server provides                                           |
| `issuer_id`             | yes      | Unique identifier for this server                                                               |
| `config`                | yes      | See [Configuration](#configuration)                                                             |
| `storage`               | yes      | Storage adapter implementing `TokenRingStorageAdapter`                                          |
| `onToken`               | yes      | Callback invoked each time the token arrives — see [onToken](#ontoken-callback)                 |
| `onServerUnresponsive`  | no       | Called after an unresponsive server is evicted — see [onServerUnresponsive](#onserverunresponsive-callback) |
| `onError`               | no       | Called when the ring is destroyed due to an error                                               |
| `onDestroy`             | no       | Called on graceful shutdown                                                                     |
| `getLocalAddress`       | no       | Override local IP discovery. Defaults to the first non-internal IPv4 interface matching `/^e.*0$/` (eth0, en0, etc.) |

## Storage adapter

The ring is decoupled from any specific database. You provide an object implementing `TokenRingStorageAdapter`:

| Method               | Purpose                                                                 |
| -------------------- | ----------------------------------------------------------------------- |
| `register`           | Upsert this server in the membership table                              |
| `deregister`         | Remove this server on graceful shutdown                                 |
| `getNextInRing`      | Return the next server after a given key (wrap around at end)           |
| `removeRegistration` | Atomically read-and-remove a registration (used for failure eviction)   |

The adapter methods may return `T` or `Promise<T>` — the ring awaits either transparently.

## Configuration

| Option                 | Description                                                              |
| ---------------------- | ------------------------------------------------------------------------ |
| `reregister_time_ms`   | How often to re-register in the membership table (heartbeat)             |
| `token_ack_timeout_ms` | How long to wait for a UDP ACK before marking a server as unresponsive   |
| `isDev`                | Skip the initial lost-token timeout and suppress the first timeout warn  |

## Capabilities

Capabilities are a `Buffer` bitmask. Each bit position represents a capability your application defines. As the token circulates, every server's capabilities are OR'd together, so the token always reflects the full set of capabilities present in the ring.

## API

### `TokenRingWorkDistributor`

- **`Start()`** — bind the UDP socket, register in the membership table, and begin participating in the ring. Returns a promise that resolves to the instance.
- **`Destroy(cause?)`** — leave the ring, close the socket, and deregister. If `cause` is provided, `onError` is called.
- **`Token`** — the most recently seen token (read-only).
- **`issuer_id`** — this server's unique identifier.
- **`segmentName`** — the ring segment this server belongs to.
- **`config`** — the active configuration.

### `onToken` callback

Called each time the token arrives at this server. Call `done({ running })` to release the token and report your current workload. Call `error(e)` to signal a fatal error.

### `onServerUnresponsive` callback

Called after the ring evicts an unresponsive server. Use this to clean up any work that was assigned to the dead server.

## Testing

```bash
npm test
```

Tests use [vitest](https://vitest.dev/) and spin up real UDP sockets on localhost.

## License

ISC
