/**
 * Standardized error class for LazyRpc.
 * Ensures uniformity in error formatting across the application.
 */
export class LazyRpcError extends Error {
  constructor(message: string, scope: string, prefix = "LazyRpc") {
    super(`[${prefix}: ${scope}] ${message}`);
    this.name = "LazyRpcError";
  }
}
