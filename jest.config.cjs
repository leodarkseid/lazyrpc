/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  projects: [
    {
      displayName: "node",
      testEnvironment: "node",
      setupFiles: ["<rootDir>/jest.setup.cjs"],
      testMatch: ["<rootDir>/tests/node/**/*.test.ts"],
      transform: {
        "^.+\\.tsx?$": ["ts-jest", {}],
      },
      moduleNameMapper: {
        "^(\\.{1,2}/.*)\\.js$": "$1",
      },
    },
    {
      displayName: "browser",
      testEnvironment: "jsdom",
      testMatch: ["<rootDir>/tests/browser/**/*.test.ts"],
      transform: {
        "^.+\\.tsx?$": ["ts-jest", {}],
      },
      moduleNameMapper: {
        "^(\\.{1,2}/.*)\\.js$": "$1",
      },
    },
  ],
};