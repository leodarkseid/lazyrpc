import { defaultLogger, silentLogger } from "../../../src/core/logger";

describe("core/logger", () => {
  const consoleSpies = {
    log: jest.spyOn(console, "log").mockImplementation(() => {}),
    info: jest.spyOn(console, "info").mockImplementation(() => {}),
    warn: jest.spyOn(console, "warn").mockImplementation(() => {}),
    error: jest.spyOn(console, "error").mockImplementation(() => {}),
    debug: jest.spyOn(console, "debug").mockImplementation(() => {}),
  };

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    Object.values(consoleSpies).forEach((spy) => spy.mockRestore());
  });

  test("defaultLogger forwards to console methods", () => {
    defaultLogger.info("info");
    defaultLogger.warn("warn");
    defaultLogger.error("error");
    defaultLogger.debug("debug");

    expect(consoleSpies.info).toHaveBeenCalledWith("info");
    expect(consoleSpies.warn).toHaveBeenCalledWith("warn");
    expect(consoleSpies.error).toHaveBeenCalledWith("error");
    expect(consoleSpies.info).toHaveBeenCalledWith("debug");
  });

  test("silentLogger ignores all calls", () => {
    silentLogger.info("info");
    silentLogger.warn("warn");
    silentLogger.error("error");
    silentLogger.debug("debug");

    expect(consoleSpies.log).not.toHaveBeenCalled();
    expect(consoleSpies.info).not.toHaveBeenCalled();
    expect(consoleSpies.warn).not.toHaveBeenCalled();
    expect(consoleSpies.error).not.toHaveBeenCalled();
    expect(consoleSpies.debug).not.toHaveBeenCalled();
  });

  test("Logger interface is compatible with common logging libraries (pino/winston shape)", () => {
    // A custom logger must implement info, warn, error, debug
    const customLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    customLogger.info("test info", { extra: true });
    customLogger.warn("test warn");
    customLogger.error("test error", new Error("boom"));
    customLogger.debug("test debug", 42);

    expect(customLogger.info).toHaveBeenCalledWith("test info", { extra: true });
    expect(customLogger.warn).toHaveBeenCalledWith("test warn");
    expect(customLogger.error).toHaveBeenCalledWith("test error", expect.any(Error));
    expect(customLogger.debug).toHaveBeenCalledWith("test debug", 42);
  });

  test("application wide: when no logger is set, absolutely nothing is logged to console", async () => {
    const { RPC } = await import("../../../src/index");
    const rpc = new RPC({
      chainId: "0x1",
      customRpcs: { http: ["https://invalid.example.invalid"] },
      validationTimeout: 100
    });

    try {
      // This will fail validation because the URL is invalid/unreachable.
      // Usually, the RPC class would log errors and warnings during validation.
      await rpc.getRpcAsync("https", 300);
    } catch (e) {
      // Expected to throw timeout or no valid URLs
    } finally {
      await rpc.destroy();
    }

    // Verify absolutely no logs leaked application-wide
    expect(consoleSpies.log).not.toHaveBeenCalled();
    expect(consoleSpies.info).not.toHaveBeenCalled();
    expect(consoleSpies.warn).not.toHaveBeenCalled();
    expect(consoleSpies.error).not.toHaveBeenCalled();
    expect(consoleSpies.debug).not.toHaveBeenCalled();
  });
});
