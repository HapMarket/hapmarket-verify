// A minimal JSON-RPC client over fetch, with no SDK. Every byte the verifier
// relies on passes through here, so it does as little as possible: send,
// receive, and refuse anything that is not a well-formed answer. It never
// caches, so a stale answer cannot outlive the request that produced it.

export interface Rpc {
  request(method: string, params: readonly unknown[]): Promise<unknown>;
}

// Every failure the endpoint is responsible for is one of these. A consumer
// (the CLI, or a web verify page) can then tell "your endpoint failed or
// misbehaved, try another" apart from a bug in the verifier: an EndpointError
// is the former, any other throw the latter. It is never a draw `fail` — a
// draw that does not check out is reported as a failed Check, not thrown.
//
// `method` is the JSON-RPC method being served when it happened, so a consumer
// can say which call broke without parsing the message.
export class EndpointError extends Error {
  readonly method: string;
  constructor(method: string, message: string) {
    super(`${method}: ${message}`);
    this.name = 'EndpointError';
    this.method = method;
  }
}

// The endpoint returned a transport failure or a JSON-RPC error object. Still
// an EndpointError, with the JSON-RPC error code when the endpoint gave one.
export class RpcError extends EndpointError {
  readonly code: number | undefined;
  constructor(method: string, message: string, code?: number) {
    super(method, message);
    this.name = 'RpcError';
    this.code = code;
  }
}

const ATTEMPTS = 4;
const TIMEOUT_MS = 30_000;

export interface HttpRpcOptions {
  // Aborts an in-flight request and every retry. Combined with the per-request
  // timeout below, so whichever fires first ends the call. A page navigating
  // away, or a reader editing the endpoint mid-run, passes its own signal here.
  signal?: AbortSignal;
}

// Rejects after `ms`, or as soon as `signal` aborts, whichever comes first.
// Used for the backoff wait so an aborted run does not sit out its backoff:
// cancellation has to reach the wait, not only the fetch.
function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) return reject(signal.reason as Error);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason as Error);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// Transient failures (network errors, rate limits, 5xx) are retried with
// backoff. An error the endpoint returns inside a JSON-RPC response is not
// retried here: it is a definite answer, and the caller decides what it means.
// A caller abort is not retried either: it is deliberate, and rejects with the
// signal's reason (an AbortError), never an EndpointError.
export function httpRpc(url: string, fetchImpl: typeof fetch = fetch, options: HttpRpcOptions = {}): Rpc {
  const caller = options.signal;
  // A function, not an inline `caller?.aborted === true`: `aborted` is a live
  // getter, and reading it inline lets the type-checker treat it as settled for
  // the rest of the scope, which it is not.
  const aborted = (): boolean => caller?.aborted === true;
  let id = 0;
  return {
    async request(method, params) {
      let lastError = '';
      for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        if (aborted()) throw caller?.reason as Error;
        // delay() rejects with the caller's reason if it aborts during the
        // wait, which leaves this loop without a retry — the intended effect.
        if (attempt > 0) await delay(500 * 2 ** attempt, caller);
        let response: Response;
        try {
          response = await fetchImpl(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
            // The caller's signal and a fresh per-attempt timeout, so a stuck
            // request is abandoned and a caller abort reaches the fetch.
            signal: caller === undefined ? AbortSignal.timeout(TIMEOUT_MS) : AbortSignal.any([caller, AbortSignal.timeout(TIMEOUT_MS)]),
          });
        } catch (e) {
          // A caller abort is deliberate: propagate it, do not retry. A timeout
          // or a network error is transient: record it and try again.
          if (aborted()) throw caller?.reason as Error;
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
    throw new EndpointError(what, `result is not a JSON-RPC quantity: ${String(value)}`);
  }
  return BigInt(value);
}
