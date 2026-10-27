import { readFileSync } from 'node:fs';
import type { Rpc } from '../src/rpc.ts';

// A recording is what a real endpoint answered while the verifier ran.
export interface Recording {
  capturedAt: string;
  endpoint: string;
  chainId: string;
  block: string;
  core: string;
  fromBlock: string;
  rounds: string[];
  note: string;
  exchanges: { method: string; params: unknown[]; result: unknown }[];
}

interface LogFilter {
  address: string;
  topics: unknown[];
  fromBlock: string;
  toBlock: string;
}

interface RawLog {
  address: string;
  topics: string[];
  blockNumber: string;
}

export function loadRecording(path: string): Recording {
  return JSON.parse(readFileSync(path, 'utf8')) as Recording;
}

// Answers requests from a recording, never from the network.
//
// eth_getLogs is answered from the recorded logs only when a recorded query
// with the same address and topic filter covered the whole requested range,
// so a change in how the verifier splits ranges still replays, but a query the
// recording never saw throws rather than returning an empty list. Returning
// nothing would act out exactly the silent pruning the verifier must catch.
// eth_call is answered only for an identical recorded call.
export function replayRpc(recording: Recording): Rpc {
  const queries = recording.exchanges.filter((e) => e.method === 'eth_getLogs');
  const logs = new Map<string, RawLog>();
  for (const q of queries) {
    for (const l of q.result as (RawLog & { logIndex: string })[]) logs.set(`${l.blockNumber}:${l.logIndex}:${l.address.toLowerCase()}`, l);
  }
  return {
    async request(method, params) {
      if (method === 'eth_chainId') return recording.chainId;
      if (method === 'eth_blockNumber') return recording.block;
      if (method === 'eth_call') {
        const hit = recording.exchanges.find((e) => e.method === 'eth_call' && JSON.stringify(e.params) === JSON.stringify(params));
        if (hit === undefined) throw new Error(`replay: eth_call not in recording: ${JSON.stringify(params)}`);
        return hit.result;
      }
      if (method === 'eth_getLogs') {
        const f = params[0] as LogFilter;
        const from = BigInt(f.fromBlock);
        const to = BigInt(f.toBlock);
        const covered = queries.some((q) => {
          const r = q.params[0] as LogFilter;
          return r.address.toLowerCase() === f.address.toLowerCase() && JSON.stringify(r.topics) === JSON.stringify(f.topics) &&
            BigInt(r.fromBlock) <= from && to <= BigInt(r.toBlock);
        });
        if (!covered) throw new Error(`replay: eth_getLogs range not in recording: ${JSON.stringify(f)}`);
        return [...logs.values()].filter((l) => matches(l, f, from, to));
      }
      throw new Error(`replay: ${method} not supported`);
    },
  };
}

function matches(l: RawLog, f: LogFilter, from: bigint, to: bigint): boolean {
  const block = BigInt(l.blockNumber);
  if (l.address.toLowerCase() !== f.address.toLowerCase() || block < from || block > to) return false;
  return f.topics.every((want, i) => {
    if (want === null) return true;
    const have = l.topics[i]?.toLowerCase();
    return Array.isArray(want) ? want.some((w) => String(w).toLowerCase() === have) : String(want).toLowerCase() === have;
  });
}
