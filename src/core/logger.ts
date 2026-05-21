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
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

export const defaultLogger: Logger = {
  info: (...args: unknown[]) => { console.info(...args); },
  warn: (...args: unknown[]) => { console.warn(...args); },
  error: (...args: unknown[]) => { console.error(...args); },
  debug: (...args: unknown[]) => { console.info(...args); },
};

export const silentLogger: Logger = {
  info: (..._args: unknown[]) => { /* silent */ },
  warn: (..._args: unknown[]) => { /* silent */ },
  error: (..._args: unknown[]) => { /* silent */ },
  debug: (..._args: unknown[]) => { /* silent */ },
};
