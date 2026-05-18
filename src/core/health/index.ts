/**
 * Endpoint health tracking — failure recording, backoff, and skip logic.
 *
 * Self-contained class that owns the failure state (Map) and all operations on it.
 * No external dependencies beyond config values and the FailedURLInfo type.
 *
 * @module health
 */

import { FailedURLInfo, FailureStats } from "../../types.js";
import type { Logger } from "../logger.js";

export interface HealthConfig {
  readonly maxRetry: number;
  readonly baseBackoffDelay: number;
  readonly maxBackoffDelay: number;
  readonly timeToResetFailedURL: number;
  readonly logger: Logger;
}

export class EndpointHealthManager {
  private readonly failedURL = new Map<string, FailedURLInfo>();
  private readonly config: HealthConfig;

  constructor(config: HealthConfig) {
    this.config = config;
  }

  /**
   * Records a URL failure with exponential backoff.
   * @param url - The failed URL
   * @param count - Number of failures to add (default: 1)
   */
  recordFailure(url: string, count: number = 1): void {
    const prev = this.failedURL.get(url) ?? {
      count: 0, time: Date.now(), nextRetry: Date.now(),
    };

    const newCount = prev.count + count;
    const backoffDelay = Math.min(
      this.config.baseBackoffDelay * Math.pow(2, newCount - 1),
      this.config.maxBackoffDelay,
    );

    this.failedURL.set(url, {
      count: newCount, time: Date.now(), nextRetry: Date.now() + backoffDelay,
    });

    this.config.logger.warn(`RPC ${url} failed ${newCount} times. Next retry in ${backoffDelay}ms`);
  }

  /**
   * Checks if a URL should be skipped due to backoff or retry limits.
   */
  shouldSkip(url: string): boolean {
    const info = this.failedURL.get(url);
    if (!info) return false;

    if (Date.now() - info.time > this.config.timeToResetFailedURL) {
      this.failedURL.delete(url);
      return false;
    }

    if (info.count >= this.config.maxRetry) return true;
    if (info.nextRetry && Date.now() < info.nextRetry) return true;
    return false;
  }

  /** Clears all failure records. */
  reset(): void {
    this.failedURL.clear();
    this.config.logger.info("Cleared all failed URL records");
  }

  /** Returns failure statistics. */
  getStats(): FailureStats {
    let inBackoff = 0;
    let overMaxRetries = 0;

    this.failedURL.forEach((info) => {
      if (info.count >= this.config.maxRetry) {
        overMaxRetries++;
      } else if (info.nextRetry && Date.now() < info.nextRetry) {
        inBackoff++;
      }
    });

    return { totalFailed: this.failedURL.size, inBackoff, overMaxRetries };
  }

  /** Exposes the raw failure Map (backward compat for tests accessing rpc["failedURL"]). */
  get entries(): Map<string, FailedURLInfo> {
    return this.failedURL;
  }
}
