import {
  assertSafePayloadSize,
  measureJsonLikeSize,
  parseSafeJsonMessage,
  readSafeJsonResponse,
  safeParseJson,
} from "../../../../src/core/security/safeJson";

describe("core/security/safeJson", () => {
  test("parses valid JSON and measures payload size from content, not object reference", () => {
    const payload = { jsonrpc: "2.0", id: 1, result: "0xabc" };
    const parsed = safeParseJson(JSON.stringify(payload));

    expect(parsed).toEqual(payload);
    expect(measureJsonLikeSize(payload)).toBe(JSON.stringify(payload).length);
    expect(assertSafePayloadSize(payload, { maxBytes: 64 })).toBe(JSON.stringify(payload).length);
  });

  test("rejects JSON text over the configured byte limit", () => {
    expect(() => safeParseJson("{\"result\":\"0x123456\"}", { maxBytes: 12 })).toThrow("maximum size");
  });

  test("accepts payloads exactly at the byte limit and rejects one byte over", () => {
    const text = "{\"a\":1}";

    expect(() => safeParseJson(text, { maxBytes: text.length })).not.toThrow();
    expect(() => safeParseJson(text, { maxBytes: text.length - 1 })).toThrow("maximum size");
  });

  test.each(["__proto__", "constructor", "prototype"])("rejects forbidden key %s", (key) => {
    expect(() => safeParseJson(`{"${key}":{}}`)).toThrow("forbidden key");
  });

  test("rejects nested and escaped prototype-pollution keys", () => {
    expect(() => safeParseJson("{\"safe\":[{\"constructor\":{\"prototype\":{}}}]}")).toThrow("forbidden key");
    expect(() => safeParseJson("{\"\\u005f\\u005fproto\\u005f\\u005f\":{}}")).toThrow("forbidden key");
  });

  test("rejects excessive depth, array length, key count, and string byte length", () => {
    expect(() => safeParseJson("{\"a\":{\"b\":{\"c\":1}}}", { maxDepth: 2 })).toThrow("maximum depth");
    expect(() => safeParseJson("[1,2,3]", { maxArrayLength: 2 })).toThrow("maximum length");
    expect(() => safeParseJson("{\"a\":1,\"b\":2}", { maxKeys: 1 })).toThrow("maximum key count");
    expect(() => safeParseJson("{\"a\":\"abcdef\"}", { maxStringBytes: 4 })).toThrow("JSON string exceeds");
  });

  test("accepts depth, array length, and key count at their configured boundary", () => {
    expect(() => safeParseJson("{\"a\":{\"b\":1}}", { maxDepth: 2 })).not.toThrow();
    expect(() => safeParseJson("[1,2]", { maxArrayLength: 2 })).not.toThrow();
    expect(() => safeParseJson("{\"a\":1,\"b\":2}", { maxKeys: 2 })).not.toThrow();
  });

  test("rejects non-plain objects and circular object graphs during direct size checks", () => {
    expect(() => assertSafePayloadSize(new Date())).toThrow("non-plain object");

    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => assertSafePayloadSize(circular)).toThrow("circular reference");

    const nested: Record<string, unknown> = { child: {} };
    (nested.child as Record<string, unknown>).parent = nested;
    expect(() => assertSafePayloadSize(nested)).toThrow("circular reference");
  });

  test("measures repeated object references as duplicated payload content", () => {
    const child = { value: "0x1" };
    expect(() => assertSafePayloadSize({ left: child, right: child })).not.toThrow();
  });

  test("rejects non-finite and unsupported direct object values", () => {
    expect(() => assertSafePayloadSize({ value: Infinity })).toThrow("non-finite number");
    expect(() => assertSafePayloadSize({ value: undefined })).toThrow("unsupported undefined value");
  });

  test("parses WebSocket text and binary messages with byte limits", () => {
    const text = JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" });
    const bytes = new TextEncoder().encode(text);

    expect(parseSafeJsonMessage(text)).toEqual({ jsonrpc: "2.0", id: 1, result: "0x1" });
    expect(parseSafeJsonMessage(bytes)).toEqual({ jsonrpc: "2.0", id: 1, result: "0x1" });
    expect(parseSafeJsonMessage(bytes.buffer)).toEqual({ jsonrpc: "2.0", id: 1, result: "0x1" });
    expect(() => parseSafeJsonMessage(bytes, { maxBytes: 8 })).toThrow("maximum size");
  });

  test("rejects malformed UTF-8 binary messages", () => {
    expect(() => parseSafeJsonMessage(new Uint8Array([0xff]))).toThrow();
  });

  test("does not require TextEncoder for string payload size checks", () => {
    const original = global.TextEncoder;
    try {
      (global as any).TextEncoder = undefined;
      expect(() => safeParseJson("{\"a\":\"ok\"}")).not.toThrow();
    } finally {
      (global as any).TextEncoder = original;
    }
  });

  test("streams HTTP response bodies under the limit and rejects bad content types", async () => {
    const response = new Response(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }),
      { headers: { "content-type": "application/json" } },
    );

    await expect(readSafeJsonResponse(response)).resolves.toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: "0x1",
    });

    await expect(readSafeJsonResponse(new Response("{}", {
      headers: { "content-type": "text/plain" },
    }))).rejects.toThrow(`Invalid JSON content type: text/plain`);
  });

  test("accepts common JSON content types and rejects missing content type by default", async () => {
    await expect(readSafeJsonResponse(new Response("{}", {
      headers: { "content-type": "application/json; charset=utf-8" },
    }))).resolves.toEqual({});
    await expect(readSafeJsonResponse(new Response("{}", {
      headers: { "content-type": "application/vnd.ethereum+json" },
    }))).resolves.toEqual({});
    await expect(readSafeJsonResponse(new Response("{}"))).rejects.toThrow("Invalid JSON content type: text/plain");
    await expect(readSafeJsonResponse(new Response("{}"), {
      requireJsonContentType: false,
    })).resolves.toEqual({});
  });

  test("rejects oversized content-length before reading the body", async () => {
    const text = jest.fn(async () => "{}");
    const response = {
      headers: {
        get: (name: string) => name.toLowerCase() === "content-type"
          ? "application/json"
          : name.toLowerCase() === "content-length"
            ? "100"
            : null,
      },
      text,
    } as any as Response;

    await expect(readSafeJsonResponse(response, { maxBytes: 10 })).rejects.toThrow("maximum size");
    expect(text).not.toHaveBeenCalled();
  });

  test("rejects streaming HTTP response bodies once the byte limit is crossed", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{\"a\":\""));
        controller.enqueue(new TextEncoder().encode("1234567890"));
        controller.close();
      },
    });
    const response = new Response(stream, {
      headers: { "content-type": "application/json" },
    });

    await expect(readSafeJsonResponse(response, { maxBytes: 10 })).rejects.toThrow("maximum size");
  });

  test("rejects malformed UTF-8 streamed HTTP response bodies", async () => {
    const response = new Response(new Uint8Array([0xff]), {
      headers: { "content-type": "application/json" },
    });

    await expect(readSafeJsonResponse(response)).rejects.toThrow();
  });
});
