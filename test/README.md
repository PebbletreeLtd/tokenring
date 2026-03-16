# Tests

Integration tests for the token ring. Tests spin up real `TokenRingWorkDistributor` instances with UDP sockets bound to localhost.

## Running

```bash
npm test
```

## Verbose logging

The token ring is quiet by default. To see all debug/warn/info logs during tests, set `verbose: true` in the test config helper in `tokenRingIntegration.test.ts`:

```ts
function testTokenRingConfig(overrides?: Partial<TokenRingConfig>): TokenRingConfig {
    return {
        reregister_time_ms: 60000,
        token_ack_timeout_ms: 500,
        skipInitialTokenTimeout: true,
        verbose: true, // ← add this
        ...overrides,
    };
}
```

By default vitest captures stdout/stderr per test. To see logs inline as they happen, run with `--no-file-parallelism` and use `console.log` directly or pass `--reporter=verbose`:

```bash
npx vitest run --reporter verbose
```
