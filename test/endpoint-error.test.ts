// Every way the endpoint can fail or misbehave surfaces as an EndpointError
// (RpcError is one), so a consumer can tell "your endpoint failed, try another"
// apart from a bug in the verifier, and never show either as a draw `fail`. One
// test per throw site, plus cancellation, which must reject with an AbortError
// and never retry.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { eventTopics, fetchLogs, type EventName } from '../src/events.ts';
import { nodeKeccak256 } from '../src/node-keccak.ts';
import { EndpointError, httpRpc, parseQuantity, RpcError, type Rpc } from '../src/rpc.ts';
import { verifyRound } from '../src/verify.ts';

const keccak = nodeKeccak256();
const topics = eventTopics(keccak);
const asFetch = (f: (url: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch => f as unknown as typeof fetch;

test('parseQuantity rejects a non-quantity as an EndpointError', () => {
  assert.throws(() => parseQuantity('nope', 'eth_blockNumber'), (e) => e instanceof EndpointError && e.method === 'eth_blockNumber');
  assert.throws(() => parseQuantity(42, 'blockNumber'), (e) => e instanceof EndpointError);
});

test('fetchLogs rejects a non-array eth_getLogs result as an EndpointError', async () => {
  const rpc: Rpc = { request: async () => 'not an array' };
  const query = { address: 0n, names: ['EntryCommitted'] as EventName[], indexed: [1n], fromBlock: 1n, toBlock: 2n };
  await assert.rejects(fetchLogs(rpc, topics, query), (e) => e instanceof EndpointError && e.method === 'eth_getLogs');
});

test('a wrong-length eth_call result is an EndpointError, not a draw failure', async () => {
  // roundOf() must return five words; four is a misbehaving endpoint.
  const rpc: Rpc = {
    async request(method) {
      if (method === 'eth_chainId') return '0x61';
      if (method === 'eth_blockNumber') return '0x10';
      if (method === 'eth_getLogs') return [];
      if (method === 'eth_call') return '0x' + '00'.repeat(32 * 4);
      throw new Error(`unexpected ${method}`);
    },
  };
  await assert.rejects(
    verifyRound({ rpc, keccak, core: 1n, roundId: 1n, fromBlock: 1n }),
    (e) => e instanceof EndpointError && e.method === 'eth_call',
  );
});

test('a JSON-RPC error object is an RpcError (an EndpointError) and is not retried', async () => {
  let calls = 0;
  const fetchImpl = asFetch(async () => {
    calls++;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'boom' } }), { status: 200 });
  });
  const rpc = httpRpc('http://endpoint.invalid', fetchImpl);
  await assert.rejects(rpc.request('eth_call', []), (e) => e instanceof RpcError && e instanceof EndpointError && e.method === 'eth_call' && e.code === -32000);
  assert.equal(calls, 1, 'a definite JSON-RPC error must not be retried');
});

test('a 500 is retried, then fails as an RpcError', async () => {
  let calls = 0;
  const fetchImpl = asFetch(async () => {
    calls++;
    return new Response('upstream', { status: 500 });
  });
  const rpc = httpRpc('http://endpoint.invalid', fetchImpl);
  await assert.rejects(rpc.request('eth_blockNumber', []), (e) => e instanceof RpcError);
  assert.equal(calls, 4, 'four attempts before giving up');
});

test('an already-aborted signal rejects with AbortError and never calls fetch', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  const fetchImpl = asFetch(async () => {
    calls++;
    return new Response('{}', { status: 200 });
  });
  const rpc = httpRpc('http://endpoint.invalid', fetchImpl, { signal: controller.signal });
  await assert.rejects(rpc.request('eth_blockNumber', []), (e) => (e as Error).name === 'AbortError');
  assert.equal(calls, 0);
});

test('aborting during the backoff wait rejects with AbortError and stops retrying', async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetchImpl = asFetch(async () => {
    calls++;
    // First attempt returns a 500 so the client enters its backoff wait; the
    // abort fires during that wait, before a second fetch.
    if (calls === 1) {
      setTimeout(() => controller.abort(), 10);
      return new Response('upstream', { status: 500 });
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), { status: 200 });
  });
  const rpc = httpRpc('http://endpoint.invalid', fetchImpl, { signal: controller.signal });
  await assert.rejects(rpc.request('eth_blockNumber', []), (e) => (e as Error).name === 'AbortError');
  assert.equal(calls, 1, 'the backoff wait was aborted, so no second attempt ran');
});

test('a non-aborted signal does not interfere with a normal result', async () => {
  const controller = new AbortController();
  const fetchImpl = asFetch(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x61' }), { status: 200 }));
  const rpc = httpRpc('http://endpoint.invalid', fetchImpl, { signal: controller.signal });
  assert.equal(await rpc.request('eth_chainId', []), '0x61');
});
