import { LazyRpcError } from "./core/error.js";

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new LazyRpcError(message, "Tools");
  }
}
