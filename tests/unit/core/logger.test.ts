import { defaultLogger, silentLogger } from "../../../src/core/logger";

describe("core/logger", () => {
  const consoleSpies = {
    log: jest.spyOn(console, "log").mockImplementation(() => {}),
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

    expect(consoleSpies.log).toHaveBeenCalledWith("info");
    expect(consoleSpies.warn).toHaveBeenCalledWith("warn");
    expect(consoleSpies.error).toHaveBeenCalledWith("error");
    expect(consoleSpies.debug).toHaveBeenCalledWith("debug");
  });

  test("silentLogger ignores all calls", () => {
    silentLogger.info("info");
    silentLogger.warn("warn");
    silentLogger.error("error");
    silentLogger.debug("debug");

    expect(consoleSpies.log).not.toHaveBeenCalled();
    expect(consoleSpies.warn).not.toHaveBeenCalled();
    expect(consoleSpies.error).not.toHaveBeenCalled();
    expect(consoleSpies.debug).not.toHaveBeenCalled();
  });
});
