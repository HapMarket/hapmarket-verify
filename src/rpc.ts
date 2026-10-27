// A minimal JSON-RPC client over fetch, with no SDK. Every byte the verifier
// relies on passes through here, so it does as little as possible: send,
// receive, and refuse anything that is not a well-formed answer. It never
// caches, so a stale answer cannot outlive the request that produced it.

export interface Rpc {
  request(method: string, params: readonly unknown[]): Promise<unknown>;
}

export class RpcError extends Error {
  readonly method: string;
  readonly code: number | undefined;
  constructor(method: string, message: string, code?: number) {
    super(`${method}: ${message}`);
    this.method = method;
    this.code = code;
  }
}

const ATTEMPTS = 4;

// Transient failures (network errors, rate limits, 5xx) are retried with
// backoff. An error the endpoint returns inside a JSON-RPC response is not
// retried here: it is a definite answer, and the caller decides what it means.
export function httpRpc(url: string, fetchImpl: typeof fetch = fetch): Rpc {
  let id = 0;
  return {
    async request(method, params) {
      let lastError = '';
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        if (attempt > 0) await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
            signal: AbortSignal.timeout(30_000),
          });
        } catch (e) {
          lastError = e instanceof Error ? e.message : String(e);
          continue;
        }
        if (response.status === 429 || response.status >= 500) {
          lastError = `HTTP ${response.status}`;
          continue;
        }
        if (!response.ok) throw new RpcError(method, `HTTP ${response.status}`);
        const body: unknown = await response.json().catch(() => undefined);
        if (typeof body !== 'object' || body === null) throw new RpcError(method, 'response is not a JSON object');
        const { result, error } = body as { result?: unknown; error?: { code?: unknown; message?: unknown } };
        if (error !== undefined) {
          throw new RpcError(method, String(error.message ?? 'unknown error'), typeof error.code === 'number' ? error.code : undefined);
        }
        if (result === undefined) throw new RpcError(method, 'response has neither result nor error');
        return result;
      }
      throw new RpcError(method, `failed after ${ATTEMPTS} attempts: ${lastError}`);
    },
  };
}

// Shows where results came from without leaking a key embedded in the URL,
// as provider URLs often carry one in the path or query.
export function describeEndpoint(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(unparseable URL)';
  }
}

export function quantity(value: bigint): string {
  return '0x' + value.toString(16);
}

export function parseQuantity(value: unknown, what: string): bigint {
  if (typeof value !== 'string' || !/^0x(0|[1-9a-f][0-9a-f]*)$/.test(value)) {
    throw new Error(`${what} is not a JSON-RPC quantity: ${String(value)}`);
  }
  return BigInt(value);
}
