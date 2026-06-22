# LAZY RPC
![NPM Version](https://img.shields.io/npm/v/lazy-rpc)
![License](https://img.shields.io/npm/l/lazy-rpc)
![Bundle Size](https://img.shields.io/bundlephobia/minzip/lazy-rpc)

## Overview

LAZY RPC was built to solve a critical problem in Web3 development: **making blockchain interactions cheaper and more reliable**. 

Free public RPC nodes are notoriously unstable and heavily rate-limited. Relying on just one or two often leads to throttled requests, forcing developers to pay for expensive premium RPC subscriptions or third-party SaaS aggregators. 

**LAZY RPC is a lightweight, native endpoint aggregator that runs directly in your server or client.** Unlike a proxy that intercepts your network traffic, LAZY RPC simply sits in the background, continuously validating, ranking, and managing a massive pool of free public endpoints. When your application needs to make a blockchain call, it instantly hands you a fast, fresh, and working URL to use. This allows you to aggressively utilize free infrastructure without hitting rate limits—drastically reducing your operating costs while avoiding the single point of failure and latency overhead of centralized providers.

Not only does it manage public nodes out-of-the-box, but it also gives you the flexibility to **add your own private RPCs** (like Infura or Alchemy) to the mix, acting as your ultimate fallback mechanism. 

Behind the scenes, its strict **Producer/Consumer architecture** continuously monitors endpoint health—ensuring every node in its active pool is **working and fully synced**. It provides massive performance gains, a very low memory footprint, and maximum compatibility in both **Node.js and Browser environments**.

Crucially, Lazy RPC is highly secure but completely non-obstructive. Its background processing is intelligent enough to sample endpoints, apply smart exponential backoff, and manage URL rotation—meaning it will **never** clog your network queue or cause visible spikes in your CPU/memory usage. It seamlessly guarantees strict endpoint correctness while remaining entirely invisible to your hot path.

## Why Lazy RPC?

**1. Plug and Play: Bundled & Custom RPCs**
You don't need to hunt for RPC URLs. Lazy RPC comes bundled with verified public endpoints for 15+ major EVM chains out-of-the-box. Just instantiate it with your desired `chainId` and immediately start requesting fast, working URLs. Have your own premium RPCs (like Infura or Alchemy), or need to support a bespoke blockchain? You can effortlessly provide your own nodes to be managed alongside the bundled ones. 

**2. The "Invisible" Architecture (Zero Memory Bloat)**
Managing dozens of RPC endpoints requires continuously pinging them in the background. Standard polling loops bloat memory, cause GC spikes, and drag down the Node.js event loop—competing directly with your application. Lazy RPC bypasses heavy Web APIs entirely in Node.js. By default, it executes its background validation pings using a highly-tuned [Undici](https://undici.nodejs.org/) socket pool and incrementally parses raw byte-streams. 
- **The Result:** It uses **~65% less RAM** than standard `fetch` implementations, completely eliminating GC spikes.
- **Highly Configurable:** While the defaults are heavily optimized, the validation layer is completely network-agnostic. You can configure it down to the exact network `Agent`, inject custom proxies, or bring your own `fetch` wrapper.

**3. Bulletproof Security by Default**
Public RPC nodes are untrusted territory. Lazy RPC inherently protects your application from malicious endpoints. With zero configuration, you are automatically shielded against malicious payload injection, Out-Of-Memory (OOM) attacks from gargantuan JSON blobs, Regex Denial of Service (ReDoS), and Prototype Pollution. 

**4. Lightning-Fast Producer/Consumer Separation**
Lazy RPC uses a strict **producer/consumer** separation internally:

- **Producer** (`initialize()`) — Runs in the background as soon as the instance is constructed. It validates RPC URLs in batches of 10, testing each with an `eth_blockNumber` call and measuring latency. Valid endpoints are sorted by speed and placed into the consumer pool. This runs on a configurable TTL cycle to continuously refresh the pool.

- **Consumers** (`getRpc()` / `getRpcAsync()`) — These methods **only read** from the validated pool. They never trigger network requests themselves. This means:
  - No consumer ever blocks on a slow endpoint
  - The validated pool is always populated by the background producer
  - Multiple callers can read concurrently without contention

This separation means that even with 10,000 candidate URLs, consumers never wait for the full validation sweep — they get results as soon as the first batch validates.

**5. Zero-Overhead Browser Fallback**
When running in the browser, Lazy RPC gracefully falls back to the native `window.fetch` and `window.WebSocket` endpoints for a lightweight, zero-dependency deployment that maximizes compatibility without bloating your bundle size. In the browser, custom RPC configurations can be imported directly and passed into the instance, bypassing `pathToRpcJson`.

## Features

- ✅ **Architectural Dual-Support**: Maximum compatibility natively tailored for both Node.js (via Undici) and browsers (via native `fetch`/`WebSocket`).
- ✅ **Producer/Consumer Model**: Background validation feeds a ready pool — consumers never trigger I/O.
- ✅ **Streaming Resolution**: `getRpcAsync()` resolves as soon as the first URL validates, not after the entire list.
- ✅ **Lifecycle Awareness**: `status()` method tracks initialization → refreshing → ready → destroyed states.
- ✅ **Extreme Performance**: Low memory footprint and lightning-fast URL resolution.
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

// Clean up when done (Releases TCP sockets / Memory handles) N.B. The library will eventually do this itself, this is a more deterministic way to ensure it get done
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
// — you don't wait for all 10,000 URLs to be checked, on detection of any valid url, all queued async request are resolved immediately with that url
const url = await rpc.getRpcAsync("https");
```

> **TL;DR**: Use `getRpcAsync()` if you want the first available URL as fast as possible. Use `getRpc()` + `status()` if you need synchronous access in a hot path and can confirm the library is ready. Initialize early in your system bootstrap — the library begins validation immediately on construction.

### How `getRpcAsync()` Works

When called before any URL has been validated:

1. A promise is parked in an internal queue with a configurable timeout (default: 10s)
2. The background producer validates URLs in batches of 10
3. The **instant** the first URL in any batch validates successfully, all queued promises resolve with that URL
4. No waiting for the full URL list — first result wins

When called after URLs are already validated, it returns immediately via `getRpc()` with the selected strategy for load balancing applied.

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

Use `customRpcs` to **append** your own endpoints (private nodes, Infura, Alchemy, etc.) into the pool alongside the built-in list — without replacing anything. `customRpcs` flexibly accepts both simple URL strings and fully featured endpoint objects (useful for injecting authentication headers or dynamic query parameters).

```typescript
import { RPC } from "lazy-rpc";

const rpc = new RPC({
  chainId: "0x0001",
  customRpcs: {
    http: [
      "https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
      { 
        url: "https://my-secure-node.internal", 
        headers: { "Authorization": "Bearer MY_TOKEN" }
      }
    ],
    ws: [
      "wss://eth-mainnet.g.alchemy.com/v2/YOUR_KEY",
      { 
        url: "wss://my-secure-node.internal", 
      }
    ]
  }
});
```

The `customRpcs` object accepts two optional keys:

| Key | Type | Description |
|-----|------|-------------|
| `http` | `(string \| HttpRpcEndpointOptions)[]` | HTTP(S) RPC endpoints to add to the pool |
| `ws` | `(string \| HttpRpcEndpointOptions)[]` | WebSocket (WS/WSS) RPC endpoints to add to the pool |

> **Note:** The exact types you provide in `customRpcs` (whether strings or objects) are preserved. If you pass an object with `headers` or `query`, the `getRpc()` and `getRpcAsync()` methods will return that exact object back to you so you can easily apply the identical configurations to your downstream requests!

#### Endpoint Objects (`HttpRpcEndpointOptions`)

If you choose to pass objects instead of raw strings, the objects must satisfy the following interface:

```typescript
interface HttpRpcEndpointOptions {
  url: string; // Required: The target HTTP or WS url
  
  // Optional: Static or dynamically resolved headers
  headers?: Record<string, string> | (() => Promise<Record<string, string>>);
  
  // Optional: Static or dynamically resolved query parameters
  query?: Record<string, string> | (() => Promise<Record<string, string>>);
}
```
This is extremely powerful because it allows you to asynchronously resolve authentication tokens or rotating API keys exactly at the moment of connection (even during background pings) without blocking or caching stale credentials!

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
interface RPCConfig<THttp = string, TWs = string> {
  chainId: string | number;           // Required: Blockchain chain ID (e.g. "0x0001", "137", or 137)
  ttl?: number;                      // Optional: Refresh interval in seconds (1-3600, default: 1200 / 20 minutes)
  maxRetry?: number;                 // Optional: Max retries before dropping (0-10, default: 3)
  pathToRpcJson?: string;           // Optional: Custom RPC list file path (Node.js only, replaces built-in list)
  customRpcs?: CustomRpcs<THttp, TWs>; // Optional: Additional RPCs to merge into the base list
  log?: boolean | Logger;           // Optional: Enable logging or provide custom Logger interface (default: false)
  loadBalancing?: LoadBalancingStrategy; // Optional: Load balancing strategy (default: "fastest")
  
  // Advanced Timing & Failure Tolerances
  validationTimeout?: number;       // Optional: Timeout for validation pings in ms (default: 5000)
  baseBackoffDelay?: number;        // Optional: Starting penalty ms for failing endpoints (default: 1800000 / 30 minutes)
  maxBackoffDelay?: number;         // Optional: Max penalty ms for failing endpoints (default: 3600000 / 1 hour)
  timeToResetFailedURL?: number;    // Optional: How long until an endpoint's failure score resets (default: 6 hours)

  // Strict Routing & Network Security
  enforceHttps?: boolean;           // Optional: Silently drop non-secure (http/ws) endpoints (default: true)
  agent?: unknown;                  // Optional: Inject custom Undici/HTTP agents for routing overrides (e.g. strict IPv4)
  fetchFn?: typeof fetch;           // Optional: Bring-your-own fetch adapter (e.g. Axios wrappers, custom network handlers)

  // Out-of-Memory (OOM) Protection - Deep JSON Constraints
  maxPayloadBytes?: number;         // Optional: Max JSON RPC response size in bytes (default: 2048 / 2KB)
  maxPayloadDepth?: number;         // Optional: Max JSON nesting depth (default: 3)
  maxPayloadKeys?: number;          // Optional: Max total object key count in JSON (default: 10)
  maxPayloadArrayLength?: number;   // Optional: Max JSON array length (default: 10)
  maxPayloadStringBytes?: number;   // Optional: Max bytes for any single JSON string (default: 100)
  requireJsonContentType?: boolean; // Optional: Require "application/json" on HTTP responses (default: true)
}

interface CustomRpcs<THttp = string, TWs = string> {
  http?: THttp[];                    // HTTP(S) endpoint URLs or configuration objects
  ws?: TWs[];                        // WebSocket endpoint URLs or configuration objects
}

type LoadBalancingStrategy = "fastest" | "round-robin" | "random";

type RPCStatus = "initializing" | "refreshing" | "ready" | "destroyed";
```

> [!NOTE]
> Chain IDs can now be flexibly provided as a strict hex string (e.g., `"0x0001"`), a decimal string (e.g., `"137"`), or a standard number (e.g., `137`). The library will automatically parse and convert them to the strict internal format required for resolution.

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

### Custom Fetchers and Agents (For Background Validation)

Lazy RPC's internal validation layer is completely stateless and network-agnostic. While LAZY RPC **does not** intercept your application's traffic, it does perform its own network requests to validate nodes in the background. This gives you maximum configurability to override the underlying mechanism used for these background pings, allowing you to seamlessly plug in custom HTTP clients like Axios, provide unique Undici dispatchers, or enforce complex routing proxies.

#### 1. Injecting a Custom Agent or Dispatcher
If you are operating in an environment with strict egress requirements (e.g. enforcing IPv4, routing through a corporate proxy, or using custom TLS certificates), you can provide your own network agent. The library will automatically attach it to all of its internal background validation calls.

```typescript
import { RPC } from "lazy-rpc";
import { Agent } from "undici";

// Define your custom dispatcher
// Example: Force IPv4 resolution
const myCustomAgent = new Agent({ 
  connect: { family: 4 } 
});

// Plug it into the instance
const rpcWithAgent = new RPC({
  chainId: "0x0001",
  agent: myCustomAgent 
});
```

#### 2. Bringing Your Own Fetcher (Axios, Node Fetch, etc.)
By default, Lazy RPC uses a highly-tuned Undici `fetch` client in Node.js and the native `window.fetch` in browsers. If you prefer to use a completely different networking library (like Axios or `node-fetch`), you can override the internal fetcher via the `fetchFn` property.

> [!WARNING]
> **SECURITY WARNING:** lazy-rpc achieves its un-crashable runtime defense by parsing raw, incoming byte streams incrementally. If you override `fetchFn` using traditional higher-level libraries like Axios or Superagent without stream-passthrough options, you will disable the `maxPayloadBytes` protection layer and allow full-payload buffering memory exploits. For proxy routing, prefer passing an Undici `ProxyAgent` into the native `agent` parameter instead.

Because external libraries often have different API signatures (e.g., `axios.post(url, data)` vs `fetch(url, options)`), you must provide an **Adapter Function**. The adapter translates Lazy RPC's standard `fetch` payload into your library's format, and then maps the response back into a format Lazy RPC expects.

**Example A: Using an Axios Adapter**

```typescript
import { RPC } from "lazy-rpc";
import axios from "axios";

// 1. Define the adapter to bridge the API gap
const secureAxiosAdapter = async (url: string, options: any) => {
  const response = await axios.post(url, options.body, {
    headers: options.headers,
    signal: options.signal,
    // 👇 FORCE AXIOS TO LEAVE THE RAW STREAM ALONE (Node.js environment)
    responseType: 'stream', 
    validateStatus: () => true
  });

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    headers: new Headers(response.headers as any),
    // Pass the raw, unread stream directly to your secure parser
    body: response.data 
  } as unknown as Response;
};

// 2. Plug the adapter into the instance
const rpcWithAxios = new RPC({
  chainId: "0x0001",
  fetchFn: secureAxiosAdapter
});
```

**Example B: Using a Custom Fetch wrapper (e.g., adding global headers)**

> **Note:** Lazy RPC now natively supports injecting dynamic headers and query parameters on a per-endpoint basis via the `customRpcs` config object (see the Custom RPCs section above). However, if you are integrating with an existing fetch wrapper that already handles this logic, you can seamlessly provide it:

```typescript
import { RPC } from "lazy-rpc";

// 1. Define a custom fetch wrapper
const authenticatedFetch = async (url: string, options: any) => {
  const newOptions = {
    ...options,
    headers: {
      ...options.headers,
      "Authorization": "Bearer MY_SECRET_TOKEN"
    }
  };
  
  // Call the native fetch with your intercepted options
  return fetch(url, newOptions);
};

// 2. Plug the custom fetcher into the instance
const rpcWithAuth = new RPC({
  chainId: "0x0001",
  fetchFn: authenticatedFetch
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

**Throws** if no validated URLs are available (e.g., during initial startup). Use `status()` to check readiness, or `getRpcAsync()` for automatic resolution.

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

#### `getAllCandidateRPCs(type: "ws" | "https"): string[]`
Returns every configured candidate URL loaded from the bundled list, custom JSON, and `customRpcs`, whether validated or not. This is useful for inspection and diagnostics; consumers should use `getRpc()` or `getRpcAsync()` for usable endpoints.

#### `getAllRPCs(type: "ws" | "https"): string[]`
Alias for `getAllCandidateRPCs()`.

#### `getFailureStats(): FailureStats`
Returns comprehensive tracking statistics for monitoring down nodes and backoff queues.

#### `refresh(): Promise<void>`
Manually triggers a re-validation cycle. The instance status transitions to `"refreshing"` while running.

#### `destroy(): void`
**Memory Safety**: Destroys the RPC instance, terminating all connections, TCP socket groups (Undici), internal interval timers, and pending async queue entries. **Always call this when the instance is no longer needed**. Any pending `getRpcAsync()` promises are rejected with `"RPC instance destroyed"`.

## Load Balancing Strategies

- **`fastest`** (Default): Analyzes connection latency during background validation and returns the URL of the fastest responding node.
- **`round-robin`**: Evenly rotates the returned URLs sequentially through the validated endpoint list, useful for helping your application prevent single-node rate-limiting.
- **`random`**: Randomly selects and returns a URL from the validated endpoint list.

## Error Prevention & Retry Logic

### HTTP Error & Rate-Limit Handling
Lazy RPC's architecture ensures that your application is shielded from failing nodes natively. It intercepts and gracefully handles standard network failures during validation without crashing your process:
- **`429 Too Many Requests`**: Rate-limited endpoints are seamlessly dropped from the active pool and pushed into our exponential backoff system.
- **`500 Internal Server Error` & `502 Bad Gateway`**: Nodes suffering from internal outages or gateway timeouts are automatically caught by our internal `assert(response.ok)` handlers and bypassed.
- **Dangling Connections & Timeouts**: Any node that accepts a TCP handshake but hangs indefinitely is forcefully aborted via our internal `AbortController` combined with a strict `validationTimeout`, preventing your application from leaking memory or stalling on dead network streams.

### Smart Exponential Backoff
Failed RPCs are stripped from the active pool and automatically paced in a backoff queue to stop thundering-herd API thrashing:
- 1st failure: 30 minute sleep
- 2nd failure: 1 hour sleep (capped at max)
- 3rd failure: permanently dropped from rotation
- Max backoff: 1 hour

Failed RPCs completely reset after 6 hours, allowing for node recovery from protracted outages natively.

## Security & Supply Chain Protection

Lazy RPC is architected to be fundamentally immune to Remote Code Execution (RCE) and malicious payload injection via spoofed endpoints or compromised custom JSON files.

- **No Code Execution (`eval`-free)**: The library never evaluates or executes the responses it receives.
- **Intelligent Custom Data Parsers**: We explicitly *do not* rely solely on native data parsers (like standard `JSON.parse()`) because they are notoriously "dumb" and susceptible to advanced edge cases. Instead, Lazy RPC employs a mathematically correct, highly strict custom parsing engine. This engine actively traps and rejects clever obfuscated JSON, malformed UTF-8 binary streams, and deeply nested prototype pollution attempts (e.g., `{"\\u005f\\u005fproto\\u005f\\u005f":{}}`) that bypass standard regex filters.
- **Strict Payload & In-Depth Validation**: During background validation, the library enforces the JSON-RPC 2.0 specification with extreme prejudice. It actively samples endpoints, rejecting false-positive `200 OK` responses (like HTML Captcha pages or JSON-RPC errors) gracefully, seamlessly dropping compromised URLs into a penalty box.
- **Data-Only Returns**: The library's core responsibility is returning a validated **String** (the URL) to the developer's application. It never downloads files, streams arbitrary payloads, or writes to the filesystem.
- **Strict OOM Payload Protection**: Attackers attempting to exhaust your server's memory by sending gargantuan JSON blobs will fail. Because this library only requests simple `eth_blockNumber` payloads, our custom JSON engine is intentionally tuned with extremely tight default restrictions—such as a 2KB byte limit and a max nesting depth of 3—to ruthlessly abort oversized or deeply nested payloads. You can still adjust these tolerances via the constructor (e.g., `maxPayloadBytes`, `maxPayloadDepth`) if you need compatibility with bespoke environments, though it defaults to absolute protection over standard compatibility.
- **ReDoS Immunity**: The only Regex used for validation (`/^0x[0-9a-fA-F]+$/`) is strictly bounded, making it mathematically immune to catastrophic backtracking and Regex Denial of Service attacks.
- **HTTPS Enforcement**: Malicious network actors intercepting raw HTTP traffic is neutralized automatically; the library enforces strictly secure HTTPs/WSS protocols by default, silently discarding non-encrypted channels from untrusted external lists.
- **Agent Injection (Supply Chain Firewall)**: For environments under strict data-egress requirements, custom proxy/agent dispatchers can be natively injected (`agent: new Agent({ connect: { lookup: customLookup }})`) into the core to force routing exclusively through whitelisted IPv4 subnets or private VPN gateways.
- **Zero Prototype Pollution**: The library natively merges custom RPC endpoints into flat arrays and iterates over them directly. It does not perform recursive deep-merging on nested objects, completely nullifying prototype pollution attack vectors.
- **Path Traversal Protection**: If user input is accidentally passed to the `pathToRpcJson` option, the library enforces `JSON.parse()` immediately after reading the file. Standard system files (like `/etc/passwd`) are not valid JSON, causing the parser to instantly crash and preventing file contents from being loaded into memory or leaked back to an attacker.
- **SSRF Mitigation**: The library inherently protects against typical GET-based SSRF because all validation pings are executed as strict `POST` requests with a fixed `{"method": "eth_blockNumber"}` JSON body. It never echoes the HTTP response body back to the consumer, utilizing it strictly for internal latency benchmarking.

## License

This project is licensed under the MIT License.
