# LAZY RPC DOCUMENTATION

## Overview

LAZY RPC is a robust, production-ready library designed to manage and validate Remote Procedure Call (RPC) URLs for blockchain interactions. It supports both HTTP and WebSocket (WS) calls, intelligent failure tracking, exponential backoff retry logic, load balancing strategies, and automatic validation of endpoints.

## Features

- ✅ **Multi-Protocol Support**: HTTP and WebSocket RPC endpoints
- ✅ **Smart Failure Tracking**: Exponential backoff retry logic with automatic recovery
- ✅ **Load Balancing**: Multiple strategies (fastest, round-robin, random)
- ✅ **Auto-Refresh**: Valid RPCs refreshed based on configurable TTL
- ✅ **Chain Validation**: Ensures correct blockchain chain ID usage
- ✅ **Memory Safe**: Proper cleanup of WebSocket connections and timeouts
- ✅ **TypeScript First**: Full TypeScript support with comprehensive interfaces
- ✅ **Production Ready**: Enhanced error handling, logging, and monitoring
- ✅ **Extensive Chain Support**: 15+ EVM chains built-in, **any EVM chain** via custom RPC list

## Installation

```bash
npm install lazy-rpc
```

## Quick Start

```typescript
import { RPC } from "lazy-rpc";

// Basic usage
const rpc = new RPC({
  chainId: "0x0001", // Ethereum mainnet
  ttl: 30,
  loadBalancing: "fastest"
});

// Get HTTP RPC URL
const httpUrl = rpc.getRpc("https");

// Get WebSocket RPC URL
const wsUrl = rpc.getRpc("ws");

// Handle failures
try {
  // Make your RPC call here
} catch (error) {
  rpc.drop(httpUrl); // Mark as failed for smart retry
}

// Clean up when done
rpc.destroy();
```

### Using Any EVM Chain

The library comes with 15+ built-in chains, but you can use **any EVM-compatible blockchain** by providing your own RPC list:

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
> Chain IDs use a zero-padded hex format specific to this library (e.g., `"0x0001"` for Ethereum mainnet, `"0x89"` for Polygon). See the [Supported Chains](#supported-chains) table for the exact values to use.

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

// Development configuration  
const devRpc = new RPC({
  chainId: "0x0001",
  ttl: 10,
  maxRetry: 2,
  loadBalancing: "fastest",
  log: true
});

// Custom RPC list
const customRpc = new RPC({
  chainId: "0x0001",
  pathToRpcJson: "/path/to/custom-rpcs.json",
  loadBalancing: "random"
});
```

## Supported Chains

| Chain | Chain ID | HTTP RPCs | WebSocket RPCs |
|-------|----------|-----------|----------------|
| Ethereum Mainnet | `0x0001` | 50+ | 7+ |
| Polygon | `0x89` | 18+ | 3+ |
| Polygon Mumbai | `0x13881` | 9+ | 2+ |
| BSC Mainnet | `0x38` | 14+ | 2+ |
| BSC Testnet | `0x61` | 6+ | 1+ |
| Arbitrum One | `0xa4b1` | 13+ | 3+ |
| Arbitrum Sepolia | `0x66eed` | 5+ | 1+ |
| Optimism | `0xa` | 14+ | 3+ |
| Optimism Sepolia | `0xaa37dc` | 6+ | 1+ |
| Base Mainnet | `0x2105` | 13+ | 3+ |
| Base Sepolia | `0x14a34` | 6+ | 1+ |
| Avalanche C-Chain | `0xa86a` | 20+ | 3+ |
| Avalanche Fuji | `0xa869` | 12+ | 2+ |

## API Reference

### Core Methods

#### `getRpc(type: "ws" | "https"): string`

Retrieves a valid RPC URL based on the configured load balancing strategy.

```typescript
const httpUrl = rpc.getRpc("https");
const wsUrl = rpc.getRpc("ws");
```

#### `getRpcAsync(type: "ws" | "https"): Promise<string>`

Asynchronously retrieves a valid RPC URL after ensuring initialization is complete.

```typescript
const httpUrl = await rpc.getRpcAsync("https");
const wsUrl = await rpc.getRpcAsync("ws");
```

#### `drop(url: string): void`

Marks an RPC URL as failed, triggering exponential backoff retry logic.

```typescript
rpc.drop("https://failed-rpc.com");
```

### Monitoring & Management

#### `getValidRPCCount(type: "ws" | "https"): number`

Returns the count of currently valid RPCs.

```typescript
const httpCount = rpc.getValidRPCCount("https");
const wsCount = rpc.getValidRPCCount("ws");
```

#### `getAllValidRPCs(type: "ws" | "https"): RPCEndpoint[]`

Returns all valid RPCs with performance metrics.

```typescript
const httpRpcs = rpc.getAllValidRPCs("https");
// Returns: [{ url: "https://...", time: 150 }, ...]
```

#### `getFailureStats(): FailureStats`

Returns comprehensive failure statistics.

```typescript
const stats = rpc.getFailureStats();
// Returns: { totalFailed: 5, inBackoff: 2, overMaxRetries: 1 }
```

#### `refresh(): Promise<void>`

Manually triggers RPC validation refresh.

```typescript
await rpc.refresh();
```

#### `clearFailedURLs(): void`

Clears all failed URL records (useful for testing or manual resets).

```typescript
rpc.clearFailedURLs();
```

#### `destroy(): void`

Destroys the RPC instance, clearing all timers and internal state. **Call this when the instance is no longer needed** to prevent memory leaks from periodic refresh timers.

```typescript
rpc.destroy();
```

## Load Balancing Strategies

### Fastest (Default)
Always returns the RPC with the lowest response time.

```typescript
const rpc = new RPC({ 
  chainId: "0x0001", 
  loadBalancing: "fastest" 
});
```

### Round Robin
Cycles through available RPCs in order, distributing load evenly.

```typescript
const rpc = new RPC({ 
  chainId: "0x0001", 
  loadBalancing: "round-robin" 
});
```

### Random
Randomly selects from available RPCs.

```typescript
const rpc = new RPC({ 
  chainId: "0x0001", 
  loadBalancing: "random" 
});
```

## Error Handling & Retry Logic

### Exponential Backoff

Failed RPCs are automatically placed in an exponential backoff queue:

- 1st failure: 1 second backoff
- 2nd failure: 2 second backoff  
- 3rd failure: 4 second backoff
- Maximum backoff: 60 seconds

### Automatic Recovery

Failed RPCs are automatically reset after 6 hours, allowing for natural recovery from temporary issues.

### Best Practices

```typescript
async function makeRpcCall(rpc: RPC) {
  const url = rpc.getRpc("https");
  
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "eth_blockNumber",
        params: [],
        id: 1
      })
    });
    
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    
    return await response.json();
  } catch (error) {
    rpc.drop(url); // Mark as failed
    throw error;
  }
}
```

## WebSocket Usage

```typescript
function createWebSocket(rpc: RPC) {
  const wsUrl = rpc.getRpc("ws");
  const ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    console.log("Connected to", wsUrl);
  };
  
  ws.onerror = (error) => {
    rpc.drop(wsUrl); // Mark as failed
    console.error("WebSocket error:", error);
  };
  
  return ws;
}
```

## Custom RPC Lists

> **Not limited to built-in chains!** Use `pathToRpcJson` to add support for **any EVM blockchain** — including private networks, testnets, L2s, and chains not in the bundled list.

### Custom RPC List Format

Create a JSON file where keys are the chain ID (hex, without `0x` prefix, prefixed with `x`), and `_WS` suffix for WebSocket endpoints:

```json
{
  "x0001": [
    "https://your-ethereum-rpc1.com",
    "https://your-ethereum-rpc2.com"
  ],
  "x0001_WS": [
    "wss://your-ethereum-ws1.com"
  ],
  "x28": [
    "https://mainnet.telos.net/evm",
    "https://rpc1.eu.telos.net/evm"
  ],
  "x28_WS": [
    "wss://mainnet.telos.net/evm"
  ]
}
```

Then pass it to the constructor:

```typescript
const rpc = new RPC({
  chainId: "0x28",  // Telos EVM
  pathToRpcJson: "/path/to/your-rpcs.json"
});
```

> If the file at `pathToRpcJson` does not exist, the library automatically falls back to the bundled list.

## Migration from v0.1.0

### Breaking Changes

1. Constructor now requires an object parameter:

```typescript
// Old (v0.1.x)
const rpc = new RPC("0x0001", 10, 3, false);

// New (v0.2.0+)
const rpc = new RPC({
  chainId: "0x0001",
  ttl: 10,
  maxRetry: 3,
  log: false
});
```

2. Enhanced error messages and validation
3. WebSocket calls now properly return Promises

### New Features

- Load balancing strategies
- Enhanced monitoring methods
- Exponential backoff retry logic
- `destroy()` method for proper cleanup
- Memory leak fixes
- TypeScript interfaces

## Performance Considerations

- **Initialization**: First RPC validation happens during construction
- **Memory Usage**: Minimal footprint with automatic cleanup
- **Network Calls**: Intelligent batching and caching
- **Retry Logic**: Exponential backoff prevents thundering herd

## Troubleshooting

### Common Issues

**No valid URLs found**
```typescript
// Check if your chain ID is supported
console.log(rpc.getValidRPCCount("https"));

// Try refreshing the RPC list
await rpc.refresh();
```

**High failure rates**
```typescript
// Check failure statistics
const stats = rpc.getFailureStats();
console.log("Failed RPCs:", stats);

// Consider decreasing TTL for more frequent validation
const rpc = new RPC({ chainId: "0x0001", ttl: 10 });
```

**WebSocket connection issues**
```typescript
// Enable logging for debugging
const rpc = new RPC({ 
  chainId: "0x0001", 
  log: true 
});
```

## Contributing

Issues and pull requests are welcome! Please see our [GitHub repository](https://github.com/leodarkseid/lazyrpc) for contribution guidelines.

## License

This project is licensed under the MIT License.
