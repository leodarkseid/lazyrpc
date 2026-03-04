/** @type {import('ts-jest').JestConfigWithTsJest} **/
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  transform: {
    "^.+\\.tsx?$": ["ts-jest", {}],
  },
};