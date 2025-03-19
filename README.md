# LAZY RPC DOCUMENTATION

## Overview

LAZY RPC is designed to manage and validate Remote Procedure Call (RPC) URLs for blockchain interactions. It supports both HTTP and WebSocket (WS) calls, failure tracking, retry logic, and automatic validation of endpoints.

## Features

- Supports HTTP and WebSocket RPC endpoints
- Tracks failed URLs and retries requests
- Auto-refreshes valid RPCs based on TTL (Time-to-Live)
- Ensures correct blockchain chain ID is used
- Logs failures for debugging (optional)

## Installation

Ensure you have Node.js installed, then import the `RPC` class into your project.

```typescript
import { RPC } from "./rpc";
```

or

```typescript
const RPC = require("./rpc");
```

## Usage

### Initializing the RPC Class

```typescript
const rpc = new RPC({
  chainId: "0x0001",
  ttl: 10,
  maxRetry: 3,
  log: true,
});
```

### Retrieving a Valid RPC URL

```typescript
const httpRpcUrl = rpc.getRpc("https");
const wsRpcUrl = rpc.getRpc("ws");
```

### Dropping a Failed URL

```typescript
rpc.drop("https://invalid-rpc.com");
```

There are two ways to handle failed Urls, have a very small ttl such that Url's are refreshed often or simply drop them in your code retry logic. A downside of the former is increased resource usage and it still doesn't gurantee that the returned url, would be functional at use time, but it does drastically increase the probabilty of the url being fresh.

The entire Library is designed to have low impact on resources in most scenarios

Initializing with Default Path

By default, RPC uses rpcList.json located in the project directory. But that's intended to contain little url's to keep the library lightweight, the library to be used can be specified by setting the absolute path to the file in the constructor argument `pathToRpcJson`.

This repo will maintain a list of public rpc, so it can simply be copied.

## Configuration Options

| Option          | Type      | Default    | Description                                |
| --------------- | --------- | ---------- | ------------------------------------------ |
| `chainId`       | `string`  | `"0x0001"` | Blockchain chain ID                        |
| `ttl`           | `number`  | `10`       | Time in seconds before RPCs are refreshed  |
| `maxRetry`      | `number`  | `3`        | Number of retries before an RPC is dropped |
| `pathToRPCJson` | `string`  | `""`       | Absolute path to list of RPCs JSON         |
| `log`           | `boolean` | `false`    | Enable logging for debugging               |

## Methods

### `getRpc(type: "ws" | "https"): string`

Retrieves a valid RPC URL of the specified type.

### `drop(url: string): void`

Drops a specified RPC URL by marking it as failed.

## Internal Logic

1. **Initialization (`init`)**:

   - Reads RPC URLs from `rpcList.json`.
   - Populates valid HTTP and WS RPCs.

2. **Re-validation (`intialize`)**:

   - Fetches fresh RPC URLs.
   - Runs HTTP and WS validation.
   - Sorts endpoints based on response time.
   - Repeats every `ttl` seconds.

3. **Failure Tracking**:
   - Tracks failed URLs with retry counts.
   - Removes URLs exceeding `maxRetry`.
   - Resets failed URLs every `timeToResetFailedURL` time.

## File Structure

```
src/
├── main.ts   # The RPC class implementation
├── tools.ts # Helper functions
├── rpcList.min.json # Contains list of available RPC URLs
```

## Example `rpcList.min.json`

It should use the hex value and also the first `0` should be removed, for Websockets, a suffix of `_WS` should be added

### N.B.

- To replace the list used pass the absolute directory of your own `json` to the `pathToRPCJson` param in the `RPC` controller
- It should also follow the same pattern for consistency

```json
{
  "x0001": [
    "https://mainnet.infura.io/v3/YOUR_PROJECT_ID",
    "https://rpc.ankr.com/eth"
  ],
  "x0001_WS": [
    "wss://mainnet.infura.io/ws/v3/YOUR_PROJECT_ID",
    "wss://rpc.ankr.com/eth/ws"
  ]
}
```

## License

This project is licensed under the MIT License.
