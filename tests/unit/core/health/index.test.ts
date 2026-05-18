import { EndpointHealthManager, type HealthConfig } from "../../../../src/core/health";
import type { Logger } from "../../../../src/core/logger";

const logger = (): jest.Mocked<Logger> => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
});

const config = (overrides: Partial<HealthConfig> = {}): HealthConfig => ({
  maxRetry: 3,
  baseBackoffDelay: 100,
  maxBackoffDelay: 1_000,
  timeToResetFailedURL: 5_000,
  logger: logger(),
  ...overrides,
});

describe("core/health", () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("records failures with exponential backoff", () => {
    const testLogger = logger();
    const health = new EndpointHealthManager(config({ logger: testLogger }));

    health.recordFailure("https://rpc.example");
    expect(health.entries.get("https://rpc.example")).toMatchObject({
      count: 1,
      time: 1_000,
      nextRetry: 1_100,
    });

    health.recordFailure("https://rpc.example");
    expect(health.entries.get("https://rpc.example")).toMatchObject({
      count: 2,
      time: 1_000,
      nextRetry: 1_200,
    });
    expect(testLogger.warn).toHaveBeenLastCalledWith("RPC https://rpc.example failed 2 times. Next retry in 200ms");
  });

  test("caps exponential backoff at the configured maximum", () => {
    const health = new EndpointHealthManager(config({ baseBackoffDelay: 500, maxBackoffDelay: 600 }));

    health.recordFailure("https://rpc.example", 3);

    expect(health.entries.get("https://rpc.example")?.nextRetry).toBe(1_600);
  });

  test("skips URLs while they are in backoff", () => {
    const health = new EndpointHealthManager(config());

    health.recordFailure("https://rpc.example");

    expect(health.shouldSkip("https://rpc.example")).toBe(true);
    jest.setSystemTime(1_101);
    expect(health.shouldSkip("https://rpc.example")).toBe(false);
  });

  test("skips URLs once max retry count is reached", () => {
    const health = new EndpointHealthManager(config({ maxRetry: 2 }));

    health.recordFailure("https://rpc.example", 2);
    jest.setSystemTime(2_000);

    expect(health.shouldSkip("https://rpc.example")).toBe(true);
  });

  test("clears stale failures after the reset window", () => {
    const health = new EndpointHealthManager(config({ timeToResetFailedURL: 1_000 }));

    health.recordFailure("https://rpc.example");
    jest.setSystemTime(2_001);

    expect(health.shouldSkip("https://rpc.example")).toBe(false);
    expect(health.entries.has("https://rpc.example")).toBe(false);
  });

  test("reset clears all failure records and logs the operation", () => {
    const testLogger = logger();
    const health = new EndpointHealthManager(config({ logger: testLogger }));

    health.recordFailure("https://rpc.example");
    health.reset();

    expect(health.entries.size).toBe(0);
    expect(testLogger.info).toHaveBeenCalledWith("Cleared all failed URL records");
  });

  test("getStats separates backoff and over-max-retry URLs", () => {
    const health = new EndpointHealthManager(config({ maxRetry: 2 }));

    health.recordFailure("https://backoff.example");
    health.recordFailure("https://maxed.example", 2);

    expect(health.getStats()).toEqual({
      totalFailed: 2,
      inBackoff: 1,
      overMaxRetries: 1,
    });
  });
});
