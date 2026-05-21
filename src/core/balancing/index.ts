/**
 * Load balancing strategies for RPC endpoint selection.
 *
 * Each strategy is a self-contained class implementing the LoadBalancer interface.
 * Stateless strategies (Fastest, Random) can be shared; RoundRobin holds its own index.
 *
 * @module balancing
 */

import { RPCEndpoint } from "../../types.js";

export interface LoadBalancer {
  select(endpoints: RPCEndpoint[], skipFn: (url: string) => boolean): RPCEndpoint | undefined;
}

export class FastestBalancer implements LoadBalancer {
  select(endpoints: RPCEndpoint[], skipFn: (url: string) => boolean): RPCEndpoint | undefined {
    return endpoints.find((e) => !skipFn(e.url));
  }
}

export class RoundRobinBalancer implements LoadBalancer {
  #index = 0;

  select(endpoints: RPCEndpoint[], skipFn: (url: string) => boolean): RPCEndpoint | undefined {
    for (let i = 0; i < endpoints.length; i++) {
      const idx = (this.#index + i) % endpoints.length;
      if (endpoints[idx]?.url && !skipFn(endpoints[idx].url)) {
        this.#index = (idx + 1) % endpoints.length;
        return endpoints[idx];
      }
    }
    return undefined;
  }
}

export class RandomBalancer implements LoadBalancer {
  select(endpoints: RPCEndpoint[], skipFn: (url: string) => boolean): RPCEndpoint | undefined {
    const valid = endpoints.filter((e) => !skipFn(e.url));
    if (valid.length === 0) return undefined;
    return valid[Math.floor(Math.random() * valid.length)];
  }
}
