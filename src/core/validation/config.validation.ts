/**
 * Config validation for RPCConfig.
 * Single source of truth — used by both core.ts and config.ts builder.
 *
 * @module config.validation
 */

import { RPCConfig } from "../../types.js";
import { LazyRpcError } from "../error.js";

/**
 * Validates the user-provided RPCConfig.
 * Throws on any invalid configuration with a descriptive error message.
 *
 * @param config - The configuration to validate
 * @throws Error if any field is invalid
 */
export function validateConfig<THttp = string, TWs = string>(config: RPCConfig<THttp, TWs>): void {
  const prefix = config.errorPrefix ?? "LazyRpc";
  const scope = "Config Validation";

  if (!config.chainId) {
    throw new LazyRpcError("chainId is required", scope, prefix);
  }

  if (typeof config.chainId === "string") {
    const trimmed = config.chainId.trim();
    if (!/^0x[0-9a-fA-F]+$/i.test(trimmed) && !/^\d+$/.test(trimmed) && !/^[0-9a-fA-F]+$/i.test(trimmed)) {
      throw new LazyRpcError("chainId must be in hex format", scope, prefix);
    }
  } else if (typeof config.chainId === "number") {
    if (!Number.isSafeInteger(config.chainId) || config.chainId < 0) {
      throw new LazyRpcError("chainId number must be a positive integer", scope, prefix);
    }
  } else {
    throw new LazyRpcError("chainId must be in hex format", scope, prefix);
  }

  if (config.ttl !== undefined && (config.ttl <= 0 || config.ttl > 3600)) {
    throw new LazyRpcError("ttl must be between 1 and 3600 seconds", scope, prefix);
  }

  if (
    config.maxRetry !== undefined &&
    (config.maxRetry < 0 || config.maxRetry > 10)
  ) {
    throw new LazyRpcError("maxRetry must be between 0 and 10", scope, prefix);
  }

  if (
    config.loadBalancing &&
    !["fastest", "round-robin", "random"].includes(config.loadBalancing)
  ) {
    throw new LazyRpcError(
      "loadBalancing must be 'fastest', 'round-robin', or 'random'",
      scope, prefix
    );
  }

  const positiveIntegerFields: [keyof RPCConfig, string][] = [
    ["maxPayloadBytes", "maxPayloadBytes"],
    ["maxPayloadDepth", "maxPayloadDepth"],
    ["maxPayloadKeys", "maxPayloadKeys"],
    ["maxPayloadArrayLength", "maxPayloadArrayLength"],
    ["maxPayloadStringBytes", "maxPayloadStringBytes"],
  ];

  for (const [field, label] of positiveIntegerFields) {
    const value = config[field];
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isInteger(value) || value <= 0)
    ) {
      throw new LazyRpcError(`${label} must be a positive integer`, scope, prefix);
    }
  }

  if (
    config.requireJsonContentType !== undefined &&
    typeof config.requireJsonContentType !== "boolean"
  ) {
    throw new LazyRpcError("requireJsonContentType must be a boolean", scope, prefix);
  }
}
