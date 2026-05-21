const DEFAULT_MAX_PAYLOAD_BYTES = 1024 * 1024;
const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_KEYS = 1_000;
const DEFAULT_MAX_ARRAY_LENGTH = 1_000;
const DEFAULT_MAX_STRING_BYTES = 256 * 1024;

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

import { LazyRpcError } from "../error.js";

export interface SafeJsonOptions {
  readonly maxBytes?: number;
  readonly maxDepth?: number;
  readonly maxKeys?: number;
  readonly maxArrayLength?: number;
  readonly maxStringBytes?: number;
  readonly requireJsonContentType?: boolean;
  readonly errorPrefix?: string;
}

export interface ResolvedSafeJsonOptions {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxKeys: number;
  readonly maxArrayLength: number;
  readonly maxStringBytes: number;
  readonly requireJsonContentType: boolean;
  readonly errorPrefix: string;
}

export function resolveSafeJsonOptions(options: SafeJsonOptions = {}): ResolvedSafeJsonOptions {
  return {
    maxBytes: options.maxBytes ?? DEFAULT_MAX_PAYLOAD_BYTES,
    maxDepth: options.maxDepth ?? DEFAULT_MAX_DEPTH,
    maxKeys: options.maxKeys ?? DEFAULT_MAX_KEYS,
    maxArrayLength: options.maxArrayLength ?? DEFAULT_MAX_ARRAY_LENGTH,
    maxStringBytes: options.maxStringBytes ?? DEFAULT_MAX_STRING_BYTES,
    requireJsonContentType: options.requireJsonContentType ?? true,
    errorPrefix: options.errorPrefix ?? "LazyRpc",
  };
}

export async function readSafeJsonResponse(response: Response, options?: SafeJsonOptions): Promise<unknown> {
  const resolved = resolveSafeJsonOptions(options);
  assertJsonContentType(response, resolved);
  assertContentLength(response, resolved);

  const text = await readLimitedResponseText(response, resolved);
  return safeParseJson(text, resolved);
}

export function safeParseJson(text: string, options?: SafeJsonOptions): unknown {
  const resolved = resolveSafeJsonOptions(options);
  const bytes = utf8ByteLength(text);

  if (bytes > resolved.maxBytes) {
    throw new Error(`JSON payload exceeds maximum size of ${resolved.maxBytes} bytes`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text, (key: string, value: unknown): unknown => {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new Error(`JSON payload contains forbidden key "${key}"`);
      }
      return value;
    });
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new LazyRpcError("Invalid JSON payload", "JSON Parser", resolved.errorPrefix);
  }

  assertSafeJsonValue(parsed, resolved);
  return parsed;
}

export function parseSafeJsonMessage(message: unknown, options?: SafeJsonOptions): unknown {
  const resolved = resolveSafeJsonOptions(options);
  const text = messageToText(message, resolved);
  return safeParseJson(text, resolved);
}

export function assertSafePayloadSize(value: unknown, options?: SafeJsonOptions): number {
  const resolved = resolveSafeJsonOptions(options);
  const bytes = measureJsonLikeSize(value, resolved);

  if (bytes > resolved.maxBytes) {
    throw new Error(`JSON payload exceeds maximum size of ${resolved.maxBytes} bytes`);
  }

  return bytes;
}

export function measureJsonLikeSize(value: unknown, options?: SafeJsonOptions): number {
  const resolved = resolveSafeJsonOptions(options);
  const seen = new WeakSet();
  const state = { total: 0 };
  measureValue(value, resolved, seen, 0, state);
  return state.total;
}

export function assertSafeJsonValue(value: unknown, options?: SafeJsonOptions): void {
  const resolved = resolveSafeJsonOptions(options);
  const seen = new WeakSet();
  let keyCount = 0;
  let nodeCount = 0;

  const visit = (current: unknown, depth: number): void => {
    nodeCount += 1;
    if (nodeCount > resolved.maxBytes) {
      throw new LazyRpcError(`JSON payload is too complex or contains a massive DAG`, "JSON Parser", resolved.errorPrefix);
    }

    if (depth > resolved.maxDepth) {
      throw new LazyRpcError(`JSON payload exceeds maximum depth of ${resolved.maxDepth}`, "JSON Parser", resolved.errorPrefix);
    }

    if (current === null) return;

    if (typeof current === "string") {
      const bytes = utf8ByteLength(current);
      if (bytes > resolved.maxStringBytes) {
        throw new LazyRpcError(`JSON string exceeds maximum size of ${resolved.maxStringBytes} bytes`, "JSON Parser", resolved.errorPrefix);
      }
      return;
    }
    if (typeof current === "number" || typeof current === "boolean") return;
    if (typeof current !== "object") {
      throw new LazyRpcError(`JSON payload contains unsupported ${typeof current} value`, "JSON Parser", resolved.errorPrefix);
    }

    const object = current;
    if (seen.has(object)) {
      throw new LazyRpcError("JSON payload contains a circular reference", "JSON Parser", resolved.errorPrefix);
    }
    seen.add(object);

    if (Array.isArray(current)) {
      if (current.length > resolved.maxArrayLength) {
        throw new LazyRpcError(`JSON array exceeds maximum length of ${resolved.maxArrayLength}`, "JSON Parser", resolved.errorPrefix);
      }
      for (const item of current) visit(item, depth + 1);
      seen.delete(object);
      return;
    }

    const prototype = Object.getPrototypeOf(current) as unknown;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new LazyRpcError("JSON payload contains a non-plain object", "JSON Parser", resolved.errorPrefix);
    }

    const entries = Object.entries(current as Record<string, unknown>);
    keyCount += entries.length;
    if (keyCount > resolved.maxKeys) {
      throw new LazyRpcError(`JSON payload exceeds maximum key count of ${resolved.maxKeys}`, "JSON Parser", resolved.errorPrefix);
    }

    for (const [key, child] of entries) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new Error(`JSON payload contains forbidden key "${key}"`);
      }
      visit(child, depth + 1);
    }
    seen.delete(object);
  };

  visit(value, 0);
}

function assertJsonContentType(response: Response, options: ResolvedSafeJsonOptions): void {
  if (!options.requireJsonContentType) return;

  const contentType = response.headers.get("content-type");
  if (!contentType) {
    throw new LazyRpcError("Missing JSON content type", "JSON Parser", options.errorPrefix);
  }


  const [firstPart = ""] = contentType.split(";");
  const mediaType = firstPart.trim().toLowerCase();
  if (mediaType !== "application/json" && !mediaType.endsWith("+json")) {
    throw new LazyRpcError(`Invalid JSON content type: ${contentType}`, "JSON Parser", options.errorPrefix);
  }
}

function assertContentLength(response: Response, options: ResolvedSafeJsonOptions): void {
  const header = response.headers.get("content-length");
  if (!header) return;

  const length = Number(header);
  if (Number.isFinite(length) && length > options.maxBytes) {
    throw new LazyRpcError(`JSON payload exceeds maximum size of ${options.maxBytes} bytes`, "JSON Parser", options.errorPrefix);
  }
}

async function readLimitedResponseText(response: Response, options: ResolvedSafeJsonOptions): Promise<string> {
  if (!response.body) {
    const text = await response.text();
    if (utf8ByteLength(text) > options.maxBytes) {
      throw new LazyRpcError(`JSON payload exceeds maximum size of ${options.maxBytes} bytes`, "JSON Parser", options.errorPrefix);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (; ;) {
      const { done, value } = await reader.read();
      if (done) break;

      total += value.byteLength;
      if (total > options.maxBytes) {
        throw new LazyRpcError(`JSON payload exceeds maximum size of ${options.maxBytes} bytes`, "JSON Parser", options.errorPrefix);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function messageToText(message: unknown, options: ResolvedSafeJsonOptions): string {
  if (typeof message === "string") {
    if (utf8ByteLength(message) > options.maxBytes) {
      throw new LazyRpcError(`JSON payload exceeds maximum size of ${options.maxBytes} bytes`, "JSON Parser", options.errorPrefix);
    }
    return message;
  }

  if (message instanceof ArrayBuffer) {
    return decodeBytes(new Uint8Array(message), options);
  }

  if (ArrayBuffer.isView(message)) {
    const view = message;
    return decodeBytes(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), options);
  }

  if (Array.isArray(message) && message.every(item => ArrayBuffer.isView(item))) {
    const total = message.reduce((sum, item) => sum + item.byteLength, 0);
    if (total > options.maxBytes) {
      throw new LazyRpcError(`JSON payload exceeds maximum size of ${options.maxBytes} bytes`, "JSON Parser", options.errorPrefix);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const item of message) {
      const view = item;
      bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength), offset);
      offset += view.byteLength;
    }
    return decodeBytes(bytes, options);
  }

  assertSafePayloadSize(message, options);
  return JSON.stringify(message);
}

function decodeBytes(bytes: Uint8Array, options: ResolvedSafeJsonOptions): string {
  if (bytes.byteLength > options.maxBytes) {
    throw new LazyRpcError(`JSON payload exceeds maximum size of ${options.maxBytes} bytes`, "JSON Parser", options.errorPrefix);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function measureValue(
  value: unknown,
  options: ResolvedSafeJsonOptions,
  seen: WeakSet<object>,
  depth: number,
  state: { total: number }
): void {
  if (depth > options.maxDepth) {
    throw new LazyRpcError(`JSON payload exceeds maximum depth of ${options.maxDepth}`, "JSON Parser", options.errorPrefix);
  }

  if (state.total > options.maxBytes) {
    throw new LazyRpcError(`JSON payload exceeds maximum size of ${options.maxBytes} bytes`, "JSON Parser", options.errorPrefix);
  }

  if (value === null) {
    state.total += 4;
    return;
  }

  switch (typeof value) {
    case "string":
      state.total += JSON.stringify(value).length === value.length + 2
        ? utf8ByteLength(value) + 2
        : utf8ByteLength(JSON.stringify(value));
      return;
    case "number":
      if (!Number.isFinite(value)) {
        throw new LazyRpcError("JSON payload contains a non-finite number", "JSON Parser", options.errorPrefix);
      }
      state.total += utf8ByteLength(String(value));
      return;
    case "boolean":
      state.total += value ? 4 : 5;
      return;
    case "object":
      break;
    default:
      throw new LazyRpcError(`JSON payload contains unsupported ${typeof value} value`, "JSON Parser", options.errorPrefix);
  }

  const object = value;
  if (seen.has(object)) {
    throw new LazyRpcError("JSON payload contains a circular reference", "JSON Parser", options.errorPrefix);
  }
  seen.add(object);

  if (Array.isArray(value)) {
    if (value.length > options.maxArrayLength) {
      throw new LazyRpcError(`JSON array exceeds maximum length of ${options.maxArrayLength}`, "JSON Parser", options.errorPrefix);
    }
    state.total += 2;
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) state.total += 1;
      if (state.total > options.maxBytes) {
        throw new LazyRpcError(`JSON payload exceeds maximum size of ${options.maxBytes} bytes`, "JSON Parser", options.errorPrefix);
      }
      measureValue(value[index], options, seen, depth + 1, state);
    }
    seen.delete(object);
    return;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new LazyRpcError("JSON payload contains a non-plain object", "JSON Parser", options.errorPrefix);
  }

  const entries = Object.entries(value as Record<string, unknown>);
  state.total += 2;
  for (const [index, [key, child]] of entries.entries()) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new LazyRpcError(`JSON payload contains forbidden key "${key}"`, "JSON Parser", options.errorPrefix);
    }
    if (index > 0) state.total += 1;
    state.total += utf8ByteLength(JSON.stringify(key)) + 1;
    if (state.total > options.maxBytes) {
      throw new LazyRpcError(`JSON payload exceeds maximum size of ${options.maxBytes} bytes`, "JSON Parser", options.errorPrefix);
    }
    measureValue(child, options, seen, depth + 1, state);
  }
  seen.delete(object);
}

function utf8ByteLength(value: string): number {
  let bytes = 0;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }

  return bytes;
}
