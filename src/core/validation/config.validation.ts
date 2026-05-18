/**
 * Config validation for RPCConfig.
 * Single source of truth — used by both core.ts and config.ts builder.
 *
 * @module config.validation
 */

import { RPCConfig } from "../../types.js";

/**
 * Validates the user-provided RPCConfig.
 * Throws on any invalid configuration with a descriptive error message.
 *
 * @param config - The configuration to validate
 * @throws Error if any field is invalid
 */
export function validateConfig(config: RPCConfig): void {
  if (!config.chainId) {
    throw new Error("chainId is required");
  }

  if (!config.chainId.startsWith("0x")) {
    throw new Error("chainId must be in hex format (e.g., '0x0001')");
  }

  if (config.ttl !== undefined && (config.ttl <= 0 || config.ttl > 3600)) {
    throw new Error("ttl must be between 1 and 3600 seconds");
  }

  if (
    config.maxRetry !== undefined &&
    (config.maxRetry < 0 || config.maxRetry > 10)
  ) {
    throw new Error("maxRetry must be between 0 and 10");
  }

  if (
    config.loadBalancing &&
    !["fastest", "round-robin", "random"].includes(config.loadBalancing)
  ) {
    throw new Error(
      "loadBalancing must be 'fastest', 'round-robin', or 'random'",
    );
  }
}