import type { Purchase } from './commitment.ts';
import { bytesToHex, hex32, hexToBytes } from './hex.ts';
import type { Keccak256 } from './keccak.ts';
import { parseQuantity, quantity, RpcError, type Rpc } from './rpc.ts';

// Event signatures, from PUBLIC-SPEC §2, §4 and §10. They were copied by hand
// from the spec, never generated from the contract: a verifier that took its
// ABI from the thing it checks would inherit that thing's mistakes.
export const SIGNATURES = {
  RoundOpened: 'RoundOpened(uint256,uint256,(uint8,bytes32,uint64,uint64,uint32,uint8,uint64,uint32,uint64,uint32,uint16))',
  TicketsPurchased: 'TicketsPurchased(uint256,address,uint256,uint256,address,uint256,uint256,address)',
  EntryCommitted: 'EntryCommitted(uint256,bytes32,uint256,uint256)',
  RandomnessRequested: 'RandomnessRequested(uint256,uint256,uint256)',
  RandomnessFulfilled: 'RandomnessFulfilled(uint256,uint256,uint256,bytes32)',
  WinnerSelected: 'WinnerSelected(uint256,uint256,uint256,address)',
  DrawForfeited: 'DrawForfeited(uint256,uint256,address)',
  RoundCancelled: 'RoundCancelled(uint256)',
  // Chainlink's VRFCoordinatorV2_5, not ours (PUBLIC-SPEC §4).
  RandomWordsFulfilled: 'RandomWordsFulfilled(uint256,uint256,uint256,uint96,bool,bool,bool)',
} as const;

export type EventName = keyof typeof SIGNATURES;

// Indexed topics after topic0, 32-byte data words, and which topics hold an
// address, for each event. A log of any other shape is rejected rather than
// decoded, and so is an address topic with any of its top 12 bytes set: no
// honest node produces one, and truncating it would invent an address.
const SHAPES: Record<EventName, { topics: number; words: number; addressTopics?: number[] }> = {
  RoundOpened: { topics: 2, words: 11 },
  TicketsPurchased: { topics: 3, words: 5, addressTopics: [1, 2] },
  EntryCommitted: { topics: 1, words: 3 },
  RandomnessRequested: { topics: 2, words: 1 },
  RandomnessFulfilled: { topics: 2, words: 2 },
  WinnerSelected: { topics: 2, words: 2, addressTopics: [1] },
  DrawForfeited: { topics: 2, words: 1, addressTopics: [1] },
  RoundCancelled: { topics: 1, words: 0 },
  RandomWordsFulfilled: { topics: 2, words: 5 },
};

export function eventTopics(keccak: Keccak256): Record<EventName, string> {
  const out = {} as Record<EventName, string>;
  for (const name of Object.keys(SIGNATURES) as EventName[]) {
    out[name] = bytesToHex(keccak(new TextEncoder().encode(SIGNATURES[name])));
  }
  return out;
}

// A log reduced to what verification reads, with its position in the chain.
export interface Log {
  name: EventName;
  address: bigint;
  topics: bigint[]; // indexed arguments, topic0 removed
  words: bigint[];
  blockNumber: bigint;
  logIndex: bigint;
}

export interface LogQuery {
  address: bigint;
  names: readonly EventName[];
  // Topic filters after topic0, null meaning any.
  indexed: readonly (bigint | null)[];
  fromBlock: bigint;
  toBlock: bigint;
}

const INITIAL_SPAN = 40_000n;
const MIN_SPAN = 500n;

// Fetches every matching log in [fromBlock, toBlock], in chunks. Endpoints cap
// the block span or result size in different ways, and say so with
// inconsistent errors, so a refused chunk is split in half and retried, down
// to MIN_SPAN, and then the error is raised. A refused chunk is never skipped:
// a missing chunk is a missing purchase.
//
// Every returned log is checked against the query. An endpoint that returns a
// log from another address, another event, outside the range, or flagged as
// removed by a reorg, is broken, and trusting it would let it insert entries.
export async function fetchLogs(rpc: Rpc, topicsByName: Record<EventName, string>, query: LogQuery): Promise<Log[]> {
  const nameByTopic = new Map(query.names.map((n) => [topicsByName[n], n] as const));
  const topicFilter = [[...nameByTopic.keys()], ...query.indexed.map((t) => (t === null ? null : hex32(t)))];
  const out: Log[] = [];
  let from = query.fromBlock;
  let span = INITIAL_SPAN;
  while (from <= query.toBlock) {
    const to = from + span - 1n < query.toBlock ? from + span - 1n : query.toBlock;
    let raw: unknown;
    try {
      raw = await rpc.request('eth_getLogs', [
        { address: '0x' + query.address.toString(16).padStart(40, '0'), topics: topicFilter, fromBlock: quantity(from), toBlock: quantity(to) },
      ]);
    } catch (e) {
      if (e instanceof RpcError && span > MIN_SPAN) {
        span /= 2n;
        continue;
      }
      throw e;
    }
    if (!Array.isArray(raw)) throw new Error(`eth_getLogs returned ${typeof raw}, not an array`);
    for (const item of raw) out.push(checkLog(item, nameByTopic, query, from, to));
    from = to + 1n;
  }
  return out;
}

function checkLog(item: unknown, nameByTopic: Map<string, EventName>, query: LogQuery, from: bigint, to: bigint): Log {
  const l = item as { address?: unknown; topics?: unknown; data?: unknown; blockNumber?: unknown; logIndex?: unknown; removed?: unknown };
  const fail = (why: string): never => {
    throw new Error(`endpoint returned a log that does not match the query (${why}): ${JSON.stringify(item)}`);
  };
  if (l.removed === true) fail('removed by a reorg');
  if (typeof l.address !== 'string' || BigInt(l.address) !== query.address) fail('wrong address');
  if (!Array.isArray(l.topics) || !l.topics.every((t) => typeof t === 'string' && /^0x[0-9a-fA-F]{64}$/.test(t))) fail('malformed topics');
  const topics = (l.topics as string[]).map((t) => t.toLowerCase());
  const name = nameByTopic.get(topics[0] ?? '') ?? fail('unrequested event');
  const shape = SHAPES[name];
  if (topics.length !== shape.topics + 1) fail(`expected ${shape.topics} indexed topics`);
  const indexed = topics.slice(1).map((t) => BigInt(t));
  for (const i of shape.addressTopics ?? []) {
    if ((indexed[i] as bigint) >> 160n !== 0n) fail(`indexed argument ${i} is not an address`);
  }
  query.indexed.forEach((want, i) => {
    if (want !== null && indexed[i] !== want) fail(`indexed argument ${i} does not match the filter`);
  });
  if (typeof l.data !== 'string') fail('missing data');
  const data = hexToBytes(l.data as string);
  if (data.length !== 32 * shape.words) fail(`expected ${shape.words} data words`);
  const words = Array.from({ length: shape.words }, (_, i) => BigInt(bytesToHex(data.subarray(32 * i, 32 * i + 32))));
  const blockNumber = parseQuantity(l.blockNumber, 'blockNumber');
  if (blockNumber < from || blockNumber > to) fail('outside the requested block range');
  return { name, address: query.address, topics: indexed, words, blockNumber, logIndex: parseQuantity(l.logIndex, 'logIndex') };
}

export function chainOrder(a: { blockNumber: bigint; logIndex: bigint }, b: { blockNumber: bigint; logIndex: bigint }): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex < b.logIndex ? -1 : a.logIndex > b.logIndex ? 1 : 0;
}

export function purchaseFromLog(log: Log): Purchase {
  return {
    buyer: log.topics[1] as bigint,
    startIndex: log.words[0] as bigint,
    endIndex: log.words[1] as bigint,
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
  };
}

// Chain order: block number, then log index within the block (PUBLIC-SPEC §2).
// Any other order yields a different commitment, so this is the one ordering
// the whole verification rests on. RPC endpoints are not trusted to return
// logs in order; they are sorted here regardless.
//
// Two logs at the same position cannot both be real, so a duplicate means the
// log source is broken. It throws rather than picking one.
export function orderPurchases(purchases: readonly Purchase[]): Purchase[] {
  const sorted = [...purchases].sort(chainOrder);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1] as Purchase;
    const cur = sorted[i] as Purchase;
    if (prev.blockNumber === cur.blockNumber && prev.logIndex === cur.logIndex) {
      throw new Error(`two purchase logs at block ${cur.blockNumber} log index ${cur.logIndex}`);
    }
  }
  return sorted;
}
