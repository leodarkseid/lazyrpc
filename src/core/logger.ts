/**
 * Structured logger interface for RPC internals.
 *
 * Two built-in implementations:
 * - `defaultLogger` — forwards to console
 * - `silentLogger` — no-ops (used when `log: false`)
 *
 * Users can supply their own Logger to integrate with any logging library.
 *
 * @module logger
 */

export interface Logger {
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
  debug: (...args: any[]) => void;
}

export const defaultLogger: Logger = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  debug: (...args) => console.debug(...args),
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};
