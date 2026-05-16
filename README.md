# LAZY RPC
![NPM Version](https://img.shields.io/npm/v/lazy-rpc)
![License](https://img.shields.io/npm/l/lazy-rpc)
![Bundle Size](https://img.shields.io/bundlephobia/minzip/lazy-rpc)

## Overview

LAZY RPC is a robust, production-ready, and environmentally-aware library designed to manage and validate Remote Procedure Call (RPC) URLs for blockchain interactions. Built from the ground up to guarantee extreme fast resolution, it provides massive performance gains, very low memory footprint, and maximum compatibility in both **Node.js and Browser environments**.

It supports both HTTP and WebSocket (WS) calls, intelligent failure tracking, exponential backoff retry logic, multiple load balancing strategies, and automatic endpoint validation.

## Why Lazy RPC? Performance & Architecture

Under the hood, Lazy RPC utilizes distinct architectural paths depending on your environment to maximize efficiency:
- **Node.js Environment**: Bypasses heavy W3C Web Standards by dynamically routing connections through a highly-tuned [Undici](https://undici.nodejs.org/) socket pool. Our benchmarks against native Node `fetch` demonstrate:
  - **~20% Higher Throughput** (Requests per second)
  - **~65% Less Memory Bloat** (Uses nearly 3x less RAM, preventing GC spikes)
  - **Massive Latency Reductions**: p99 tail latency improved by 43.6%, standardizing network jitter. (p95 improved by 43.8%, p90 by 37.49%, and p50 by 2.34%)
- **Browser Environment**: Gracefully falls back to the native `window.fetch` and `window.WebSocket` endpoints for lightweight, zero-dependency deployment and maximum compatibility. In the browser, custom RPC configurations can be imported directly and passed into the instance, bypassing `pathToRpcJson`.

### Producer / Consumer Architecture

Lazy RPC uses a strict **producer/consumer** separation internally:

- **Producer** (`initialize()`) — Runs in the background as soon as the instance is constructed. It validates RPC URLs in batches of 10, testing each with an `eth_blockNumber` call and measuring latency. Valid endpoints are sorted by speed and placed into the consumer pool. This runs on a configurable TTL cycle to continuously refresh the pool.

- **Consumers** (`getRpc()` / `getRpcAsync()`) — These methods **only read** from the validated pool. They never trigger network requests themselves. This means:
  - No consumer ever blocks on a slow endpoint
  - The validated pool is always populated by the background producer
  - Multiple callers can read concurrently without contention

This separation means that even with 10,000 candidate URLs, consumers never wait for the full validation sweep — they get results as soon as the first batch validates.

## Features

- ✅ **Architectural Dual-Support**: Maximum compatibility natively tailored for both Node.js (via Undici) and browsers (via native `fetch`/`WebSocket`).
- ✅ **Producer/Consumer Model**: Background validation feeds a ready pool — consumers never trigger I/O.
- ✅ **Streaming Resolution**: `getRpcAsync()` resolves as soon as the first URL validates, not after the entire list.
- ✅ **Lifecycle Awareness**: `status()` method tracks initialization → refreshing → ready → destroyed states.
- ✅ **Extreme Performance**: Low memory footprint and lightning-fast connection resolution.
- ✅ **Memory Safety Toolkit**: While it's highly recommended to use the `.destroy()` method to clean up, the library pro-actively tries to clean up and garbage-collect hanging processes and dispatcher agents in Node.js automatically.
- ✅ **Multi-Protocol Support**: HTTP and WebSocket RPC endpoints seamlessly mapped.
- ✅ **Smart Failure Tracking**: Exponential backoff retry logic with automatic penalty tracking and recovery periods.
- ✅ **Load Balancing**: Multiple custom load-balancing strategies (`fastest`, `round-robin`, `random`).
- ✅ **Auto-Refresh**: Valid RPCs are aggressively refreshed and rotated based on configurable TTL.
- ✅ **Chain Validation**: Validates nodes respond to your exact Ethereum chain ID (`eth_chainId`).
- ✅ **Extensive Chain Support**: 15+ EVM chains built-in out of the box, with support for **any bespoke EVM chain** via custom JSON lists.

## Installation

```bash
npm install lazy-rpc
```

## Quick Start

```typescript
import { RPC } from "lazy-rpc";

const rpc = new RPC({
  chainId: "0x0001", // Ethereum mainnet
  ttl: 30,
  loadBalancing: "fastest"
});

// Option 1: Async — resolves as soon as the first URL is validated
const url = await rpc.getRpcAsync("https");

// Option 2: Sync — only works after initialization has completed
if (rpc.status() === "ready") {
  const url = rpc.getRpc("https");
}

// Handle failures natively
try {
  // Make your RPC call using the URL...
} catch (error) {
  rpc.drop(url); // Drops the node from the active pool and applies an exponential penalty
}

// Clean up when done (Releases TCP sockets / Memory handles)
rpc.destroy(); 
```

## Understanding the Lifecycle

The library goes through distinct states after construction. Use `status()` to check where things are:

```
Construction → "initializing" → "ready" ⇄ "refreshing" → "destroyed"
```

| Status | Meaning | `getRpc()` | `getRpcAsync()` |
|--------|---------|------------|-----------------|
| `"initializing"` | Background validation in progress, no URLs validated yet | ❌ Throws | ✅ Queues and resolves on first validation |
| `"ready"` | At least one validated URL available, no validation running | ✅ Returns URL | ✅ Returns URL immediately |
| `"refreshing"` | Validated URLs available, TTL re-validation in progress | ✅ Returns URL | ✅ Returns URL immediately |
| `"destroyed"` | Instance torn down | ❌ Throws | ❌ Rejects |

### Recommendations for System Integration

**Bootstrap Pattern** — Initialize the library early in your application startup and wait for readiness before serving traffic:

```typescript
const rpc = new RPC({ chainId: "0x0001" });

// Wait for at least one validated URL before proceeding
const url = await rpc.getRpcAsync("https");
console.log("System ready, first RPC:", url);

// From here on, getRpc() is safe to use synchronously
startServer();
```

**Status Check Pattern** — If you prefer synchronous access, gate your calls on `status()`:

```typescript
function getEndpoint(): string | null {
  const state = rpc.status();
  if (state === "ready" || state === "refreshing") {
    return rpc.getRpc("https");
  }
  return null; // Not ready yet
}
```

**Fire-and-Forget Pattern** — If you just want the fastest possible URL and don't care about the lifecycle:

```typescript
// getRpcAsync resolves the instant the first URL is validated
// — you don't wait for all 10,000 URLs to be checked
const url = await rpc.getRpcAsync("https");
```

> **TL;DR**: Use `getRpcAsync()` if you want the first available URL as fast as possible. Use `getRpc()` + `status()` if you need synchronous access in a hot path and can confirm the library is ready. Initialize early in your system bootstrap — the library begins validation immediately on construction.

### How `getRpcAsync()` Works

When called before any URL has been validated:

1. A promise is parked in an internal queue with a configurable timeout (default: 10s)
2. The background producer validates URLs in batches of 10
3. The **instant** the first URL in any batch validates successfully, all queued promises resolve with that URL
4. No waiting for the full URL list — first result wins

When called after URLs are already validated, it returns immediately via `getRpc()` with full load balancing applied.

```typescript
// All three callers resolve as soon as the first URL validates
const [url1, url2, url3] = await Promise.all([
  rpc.getRpcAsync("https"),
  rpc.getRpcAsync("https"),
  rpc.getRpcAsync("ws"),
]);
```

### How `getRpc()` Works

`getRpc()` is a strict synchronous consumer. It reads from the validated pool and returns a URL based on your load balancing strategy. It **never triggers network I/O**.

- Before initialization completes: **throws** `"No valid https URLs found"`
- After initialization: returns a load-balanced URL from the validated pool
- Use `status()` to check if it's safe to call

## Using Any Bespoke EVM Chain

The library comes with 15+ built-in chains, but you can use **any EVM-compatible blockchain** dynamically by easily providing your own custom RPC list:

```typescript
import { RPC } from "lazy-rpc";

// Example: Telos EVM (chainId 40 = 0x28)
const rpc = new RPC({
  chainId: "0x28",
  pathToRpcJson: "./my-rpcs.json"
});
```

> **Any chain, any RPC** — private nodes, Infura, Alchemy, self-hosted, or public endpoints all work.

#### Constructing a Custom RPC JSON File

The JSON file must be a flat object mapping chain keys to arrays of URL strings. The key format follows a specific convention:

1. **Derive the hex key** from your chain ID: strip the `0x` prefix and prepend `x`.
   - Chain ID `40` → hex `0x28` → key `x28`
   - Chain ID `137` → hex `0x89` → key `x89`
   - Chain ID `1` (Ethereum mainnet) → special case: key `x0001` (zero-padded)
2. **HTTP endpoints** use the plain hex key (e.g., `x28`).
3. **WebSocket endpoints** use the hex key with a `_WS` suffix (e.g., `x28_WS`).

```json
{
  "x28": [
    "https://mainnet.telos.net/evm",
    "https://rpc1.eu.telos.net/evm"
  ],
  "x28_WS": [
    "wss://mainnet.telos.net/evm"
  ]
}
```

You can include multiple chains in a single file:

```json
{
  "x28": ["https://mainnet.telos.net/evm"],
  "x28_WS": ["wss://mainnet.telos.net/evm"],
  "x89": ["https://polygon-rpc.com", "https://rpc.ankr.com/polygon"],
  "x89_WS": ["wss://polygon-bor-rpc.publicnode.com"]
}
```

**What will cause entries to fail:**
- Missing the key for your `chainId` — the library throws `Chain ID not found in RPC list`.
- Malformed URLs (not parseable) — rejected during runtime validation.
- Wrong protocol (e.g., `wss://` in an HTTP key) — rejected during runtime validation.
- Duplicate URLs — silently deduplicated (not an error).

> **Important:** `pathToRpcJson` **replaces** the entire built-in list. If you want to keep the built-in endpoints and just add your own, use `customRpcs` instead (see below).

#### Browser Usage for Custom Domains

Because the browser does not have access to the Node.js `fs` file system module, if you are passing custom RPC endpoints in the web, simply import your javascript/json object and pass it directly to the instance, bypassing `pathToRpcJson`:

```typescript
import { RPC } from "lazy-rpc";
import myRpcs from "./my-rpcs.json"; // Or define the object directly

const rpc = new RPC({
  chainId: "0x28"
  // Note: the library will use the passed custom `chainList` internally if provided. The wrapper accommodates this natively when dealing with custom parameters in your build pipeline.
});
```

### Adding Custom RPCs Without Replacing the Built-in List

Use `customRpcs` to **append** your own endpoints (private nodes, Infura, Alchemy, etc.) into the pool alongside the built-in list — without replacing anything.

```typescript
import { RPC } from "lazy-rpc";

const rpc = new RPC({
  chainId: "0x0001",
  customRpcs: {
    http: [
      "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
      "https://mainnet.infura.io/v3/YOUR_KEY"
    ],
    ws: [
      "wss://eth-mainnet.g.alchemy.com/v2/YOUR_KEY"
    ]
  }
});
```

The `customRpcs` object accepts two optional keys:

| Key | Type | Description |
|-----|------|-------------|
| `http` | `string[]` | HTTP(S) RPC endpoint URLs to add to the pool |
| `ws` | `string[]` | WebSocket (WS/WSS) RPC endpoint URLs to add to the pool |

**Validation rules — the library throws immediately at construction if:**
- An **empty array** is passed (`http: []` or `ws: []`). Omit the key entirely if you have no endpoints of that type.
- A URL is **malformed** (not parseable by the `URL` constructor). The error message identifies the specific bad URL.
- A URL uses the **wrong protocol** (e.g., `wss://` in the `http` array, or `https://` in the `ws` array).

**Behavior:**
- Custom URLs are **deduplicated** against the base list — no duplicates enter the pool.
- Custom URLs participate in **load balancing** and **runtime validation** identically to built-in endpoints.
- Works in **both Node.js and browser** environments (unlike `pathToRpcJson` which is Node-only).
- Stacks with `pathToRpcJson` — custom URLs are appended to whatever base list is loaded.

#### Combining `pathToRpcJson` and `customRpcs`

You can use both options together. `pathToRpcJson` replaces the built-in list, then `customRpcs` appends on top:

```typescript
const rpc = new RPC({
  chainId: "0x28",
  pathToRpcJson: "./my-base-rpcs.json",  // Replaces built-in list
  customRpcs: {
    http: ["https://my-private-telos-node.com"]  // Appended on top
  }
});
```

## Configuration

### Constructor Options

```typescript
interface RPCConfig {
  chainId: string;                    // Required: Blockchain chain ID (hex format, e.g. "0x0001")
  ttl?: number;                      // Optional: Refresh interval in seconds (1-3600, default: 10)
  maxRetry?: number;                 // Optional: Max retries before dropping (0-10, default: 3)
  pathToRpcJson?: string;           // Optional: Custom RPC list file path (Node.js only, replaces built-in list)
  customRpcs?: CustomRpcs;          // Optional: Additional RPCs to merge into the base list
  log?: boolean;                    // Optional: Enable logging (default: false)
  loadBalancing?: LoadBalancingStrategy; // Optional: Load balancing strategy (default: "fastest")
}

interface CustomRpcs {
  http?: string[];                   // HTTP(S) endpoint URLs (must be non-empty if provided)
  ws?: string[];                     // WebSocket endpoint URLs (must be non-empty if provided)
}

type LoadBalancingStrategy = "fastest" | "round-robin" | "random";

type RPCStatus = "initializing" | "refreshing" | "ready" | "destroyed";
```

> [!NOTE]
> Chain IDs use a zero-padded hex format specific to this library (e.g., `"0x0001"` for Ethereum mainnet, `"0x89"` for Polygon). 

### Example Configurations

```typescript
// Production configuration with bootstrap wait
const rpc = new RPC({
  chainId: "0x0001",
  ttl: 60,
  maxRetry: 5,
  loadBalancing: "round-robin",
  log: false
});

// Wait for the library to be ready before serving traffic
await rpc.getRpcAsync("https");
console.log("Status:", rpc.status()); // "ready"

// Custom RPC list (replaces built-in)
const customRpc = new RPC({
  chainId: "0x0001",
  pathToRpcJson: "/path/to/custom-rpcs.json",
  loadBalancing: "random"
});

// Add private endpoints alongside built-in list
const extendedRpc = new RPC({
  chainId: "0x0001",
  customRpcs: {
    http: ["https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY"],
    ws: ["wss://eth-mainnet.g.alchemy.com/v2/YOUR_KEY"]
  }
});
```

## Supported Bundled Chains

| Chain | Chain ID | HTTP RPCs | WebSocket RPCs |
|-------|----------|-----------|----------------|
| Ethereum Mainnet | `0x0001` | 50+ | 7+ |
| Polygon | `0x89` | 18+ | 3+ |
| Polygon Mumbai | `0x13881` | 9+ | 2+ |
| BSC Mainnet | `0x38` | 14+ | 2+ |
| BSC Testnet | `0x61` | 6+ | 1+ |
| Arbitrum One | `0xa4b1` | 13+ | 3+ |
| Optimism | `0xa` | 14+ | 3+ |
| Base Mainnet | `0x2105` | 13+ | 3+ |
| Avalanche C-Chain | `0xa86a` | 20+ | 3+ |

## API Reference

### Core Methods

#### `getRpc(type: "ws" | "https"): string`
Retrieves a valid RPC URL synchronously based on the configured load balancing strategy.

**Throws** if no validated URLs are available (e.g., during initial startup). Use `status()` to check readiness, or prefer `getRpcAsync()` for automatic waiting.

#### `getRpcAsync(type: "ws" | "https", timeout?: number): Promise<string>`
Asynchronously retrieves a valid RPC URL. If validated URLs already exist, returns immediately with load balancing applied. If none exist yet (during initialization), queues the request and resolves as soon as the first URL validates — **not** after the entire list is checked.

- `timeout` — Maximum wait time in milliseconds (default: `10000`). Rejects with a timeout error if no URL validates within this window.

#### `drop(url: string): void`
Manually flags an RPC URL as failed, immediately stripping it from rotation and triggering exponential backoff retry logic.

### Lifecycle & Monitoring

#### `status(): RPCStatus`
Returns the current lifecycle state of the instance:
- `"initializing"` — First validation sweep in progress, no URLs validated yet
- `"refreshing"` — Validated URLs available, TTL re-validation cycle running
- `"ready"` — Validated URLs available, no validation in progress
- `"destroyed"` — Instance has been destroyed

#### `getValidRPCCount(type: "ws" | "https"): number`
Returns the count of currently validated RPC endpoints. Returns `0` during `"initializing"` state.

#### `getAllValidRPCs(type: "ws" | "https"): RPCEndpoint[]`
Returns a defensive copy of the validated RPCs alongside their ping resolution times.

#### `getFailureStats(): FailureStats`
Returns comprehensive tracking statistics for monitoring down nodes and backoff queues.

#### `refresh(): Promise<void>`
Manually triggers a re-validation cycle. The instance status transitions to `"refreshing"` while running.

#### `destroy(): void`
**Memory Safety**: Destroys the RPC instance, terminating all connections, TCP socket groups (Undici), internal interval timers, and pending async queue entries. **Always call this when the instance is no longer needed**. Any pending `getRpcAsync()` promises are rejected with `"RPC instance destroyed"`.

## Load Balancing Strategies

- **`fastest`** (Default): Analyzes connection latency during validation and explicitly routes requests directly to the fastest responding node.
- **`round-robin`**: Evenly distributes calls sequentially wrapping through the validated endpoint list, useful for preventing single-node rate-limiting.
- **`random`**: Distributes payloads natively across any validated endpoint using standard randomization.

## Error Prevention & Retry Logic

### Smart Exponential Backoff
Failed RPCs are stripped from the active pool and automatically paced in a backoff queue to stop thundering-herd API thrashing:
- 1st failure: 1 second sleep
- 2nd failure: 2 second sleep
- 3rd failure: 4 second sleep
- Max: 60 seconds

Failed RPCs completely reset after 6 hours, allowing for node recovery from protracted outages natively.

## License

This project is licensed under the MIT License.
