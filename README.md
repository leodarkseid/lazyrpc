# LAZY RPC
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
- **Browser Environment**: Gracefully falls back to the native `window.fetch` and `window.WebSocket` endpoints for lightweight, zero-dependency deployment and maximum compatibility. In the browser, custom RPC configurations can be imported directly and passed into the instance since `fs` is not used.

## Features

- ✅ **Architectural Dual-Support**: Maximum compatibility natively tailored for both Node.js (via Undici) and browsers (via native `fetch`/`WebSocket`).
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

// Basic usage - Works identically in Node.js and the Browser
const rpc = new RPC({
  chainId: "0x0001", // Ethereum mainnet
  ttl: 30,
  loadBalancing: "fastest"
});

// Get HTTP RPC URL
const httpUrl = rpc.getRpc("https");

// Get WebSocket RPC URL
const wsUrl = rpc.getRpc("ws");

// Handle failures natively
try {
  // Make your RPC call using the URL...
} catch (error) {
  rpc.drop(httpUrl); // Drops the node from the active pool and applies an exponential penalty
}

// Clean up when done (Releases TCP sockets / Memory handles)
rpc.destroy(); 
```

### Using Any Bespoke EVM Chain

The library comes with 15+ built-in chains, but you can use **any EVM-compatible blockchain** dynamically by easily providing your own custom RPC list:

```typescript
import { RPC } from "lazy-rpc";

// Example: Telos EVM (chainId 40 = 0x28)
const rpc = new RPC({
  chainId: "0x28",
  pathToRpcJson: "./my-rpcs.json"
});
```

```json
// my-rpcs.json
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

> **Any chain, any RPC** — private nodes, Infura, Alchemy, self-hosted, or public endpoints all work.

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

## Configuration

### Constructor Options

```typescript
interface RPCConfig {
  chainId: string;                    // Required: Blockchain chain ID (hex format, e.g. "0x0001")
  ttl?: number;                      // Optional: Refresh interval in seconds (1-3600, default: 10)
  maxRetry?: number;                 // Optional: Max retries before dropping (0-10, default: 3)
  pathToRpcJson?: string;           // Optional: Custom RPC list file path
  log?: boolean;                    // Optional: Enable logging (default: false)
  loadBalancing?: LoadBalancingStrategy; // Optional: Load balancing strategy (default: "fastest")
}

type LoadBalancingStrategy = "fastest" | "round-robin" | "random";
```

> [!NOTE]
> Chain IDs use a zero-padded hex format specific to this library (e.g., `"0x0001"` for Ethereum mainnet, `"0x89"` for Polygon). 

### Example Configurations

```typescript
// Production configuration
const prodRpc = new RPC({
  chainId: "0x0001",
  ttl: 60,
  maxRetry: 5,
  loadBalancing: "round-robin",
  log: false
});

// Custom RPC list
const customRpc = new RPC({
  chainId: "0x0001",
  pathToRpcJson: "/path/to/custom-rpcs.json",
  loadBalancing: "random"
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

#### `getRpcAsync(type: "ws" | "https"): Promise<string>`
Asynchronously retrieves a valid RPC URL, waiting natively if initialization is actively finishing.

#### `drop(url: string): void`
Manually flags an RPC URL as failed, immediately stripping it from rotation and triggering exponential backoff retry logic.

### Monitoring & Memory Management

#### `getValidRPCCount(type: "ws" | "https"): number`
Returns the count of currently actively validated RPC endpoints.

#### `getAllValidRPCs(type: "ws" | "https"): RPCEndpoint[]`
Returns the full array of valid RPCs alongside their ping resolution times.

#### `getFailureStats(): FailureStats`
Returns comprehensive tracking statistics for monitoring down nodes and backoff queues.

#### `destroy(): void`
**Memory Safety**: Destroys the RPC instance, terminating all connections, TCP socket groups (Undici), and internal interval timers. **Always call this when the instance is no longer needed**. *(Note: the library also attempts to proactively clean up processes in Node.js itself during teardown, but explicit invocation is always recommended).*

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
