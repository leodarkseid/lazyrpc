import {
  filterSecureUrls,
  mergeCustomUrls,
  validateUrl,
} from "../../../../src/core/validation/url.validation";

describe("core/validation/url.validation", () => {
  describe("validateUrl", () => {
    test.each([
      ["https://rpc.example", "http"],
      ["http://localhost:8545", "http"],
      ["wss://rpc.example", "ws"],
      ["ws://localhost:8546", "ws"],
    ] as const)("accepts %s as %s", (url, type) => {
      expect(validateUrl(url, type, { shouldThrow: true })).toBe(true);
    });

    test("returns false for malformed URLs when not throwing", () => {
      expect(validateUrl("not a url", "http", { shouldThrow: false })).toBe(false);
    });

    test("throws a labelled error for malformed custom URLs", () => {
      expect(() => validateUrl("not a url", "http", {
        shouldThrow: true,
        label: "customRpcs.http",
      })).toThrow("Invalid URL in customRpcs.http: \"not a url\" is not a valid URL");
    });

    test("rejects HTTP URLs with WebSocket protocols", () => {
      expect(validateUrl("wss://rpc.example", "http", { shouldThrow: false })).toBe(false);
      expect(() => validateUrl("wss://rpc.example", "http", { shouldThrow: true }))
        .toThrow('expected "http:" or "https:"');
    });

    test("rejects WebSocket URLs with HTTP protocols", () => {
      expect(validateUrl("https://rpc.example", "ws", { shouldThrow: false })).toBe(false);
      expect(() => validateUrl("https://rpc.example", "ws", { shouldThrow: true }))
        .toThrow('expected "ws:" or "wss:"');
    });
  });

  describe("mergeCustomUrls", () => {
    test("returns the original base list when custom URLs are omitted", () => {
      const base: any = [{url: "https://rpc.example", originalFormat: "string" as const}];

      expect(mergeCustomUrls(base, undefined, "http")).toBe(base);
    });

    test("validates, merges, and deduplicates custom URLs", () => {
      expect(mergeCustomUrls(
        [{url: "https://rpc.example", originalFormat: "string" as const}],
        ["https://rpc.example", "https://custom.example"],
        "http",
      )).toEqual([{url: "https://rpc.example", originalFormat: "string" as const}, {url: "https://custom.example", originalFormat: "string" as const}]);
    });

    test("validates, merges, and deduplicates custom endpoint objects", () => {
      expect(mergeCustomUrls(
        [{url: "https://rpc.example", originalFormat: "string" as const}],
        [
          "https://rpc.example", 
          "https://custom.example", 
          { url: "https://custom2.example", headers: { "Authorization": "Bearer 123" } }
        ],
        "http",
      )).toEqual([
        {url: "https://rpc.example", originalFormat: "string" as const}, 
        {url: "https://custom.example", originalFormat: "string" as const},
        {url: "https://custom2.example", headers: { "Authorization": "Bearer 123" }, originalFormat: "object" as const}
      ]);
    });

    test("throws for empty custom URL arrays", () => {
      expect(() => mergeCustomUrls([], [], "ws")).toThrow("customRpcs.ws array cannot be empty");
    });

    test("throws for invalid custom URL protocols", () => {
      expect(() => mergeCustomUrls([], ["ftp://rpc.example"], "http")).toThrow("Invalid protocol in customRpcs.http");
    });
  });

  describe("filterSecureUrls", () => {
    test("keeps HTTPS endpoints and local HTTP endpoints", () => {
      expect(filterSecureUrls([
        { url: "https://rpc.example", originalFormat: "string" as const },
        { url: "http://rpc.example", originalFormat: "string" as const },
        { url: "http://localhost:8545", originalFormat: "string" as const },
        { url: "http://127.0.0.1:8545", originalFormat: "string" as const },
      ], "http")).toEqual([
        { url: "https://rpc.example", originalFormat: "string" as const },
        { url: "http://localhost:8545", originalFormat: "string" as const },
        { url: "http://127.0.0.1:8545", originalFormat: "string" as const },
      ]);
    });

    test("keeps WSS endpoints and local WS endpoints", () => {
      expect(filterSecureUrls([
        { url: "wss://rpc.example", originalFormat: "string" as const },
        { url: "ws://rpc.example", originalFormat: "string" as const },
        { url: "ws://localhost:8546", originalFormat: "string" as const },
        { url: "ws://127.0.0.1:8546", originalFormat: "string" as const },
      ], "ws")).toEqual([
        { url: "wss://rpc.example", originalFormat: "string" as const },
        { url: "ws://localhost:8546", originalFormat: "string" as const },
        { url: "ws://127.0.0.1:8546", originalFormat: "string" as const },
      ]);
    });

    test("keeps IPv6 localhost [::1] for both HTTP and WS", () => {
      expect(filterSecureUrls([
        { url: "http://[::1]:8545", originalFormat: "string" as const },
        { url: "http://rpc.example", originalFormat: "string" as const },
        { url: "https://rpc.example", originalFormat: "string" as const },
      ], "http")).toEqual([
        { url: "http://[::1]:8545", originalFormat: "string" as const },
        { url: "https://rpc.example", originalFormat: "string" as const },
      ]);

      expect(filterSecureUrls([
        { url: "ws://[::1]:8546", originalFormat: "string" as const },
        { url: "ws://rpc.example", originalFormat: "string" as const },
        { url: "wss://rpc.example", originalFormat: "string" as const },
      ] as any, "ws")).toEqual([
        { url: "ws://[::1]:8546", originalFormat: "string" as const },
        { url: "wss://rpc.example", originalFormat: "string" as const },
      ]);
    });
  });
});
