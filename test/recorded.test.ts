// Replays recorded testnet draws through the full verifier, offline. Then,
// for each way a draw could be falsified or a data source could fail, tampers
// with one fact in a recording and asserts the check built for it fails. A
// verifier is only as good as the failures it can be shown to catch.

import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { eventTopics, fetchLogs, type EventName } from '../src/events.ts';
import { bytesToHex } from '../src/hex.ts';
import { nodeKeccak256 } from '../src/node-keccak.ts';
import { overall } from '../src/report.ts';
import { verifyRound, type Status } from '../src/verify.ts';
import { loadRecording, replayRpc, type Recording } from './replay.ts';

const keccak = nodeKeccak256();
const DIR = join(import.meta.dirname, 'recorded');
const topics = eventTopics(keccak);

async function run(rec: Recording, round: string): Promise<{ status: Status; failed: string[]; statuses: Map<string, Status> }> {
  const report = await verifyRound({ rpc: replayRpc(rec), keccak, core: BigInt(rec.core), roundId: BigInt(round), fromBlock: BigInt(rec.fromBlock) });
  const statuses = new Map(report.checks.map((c) => [c.id, c.status] as const));
  return { status: overall(report), failed: report.checks.filter((c) => c.status === 'fail').map((c) => c.id), statuses };
}

// Recorded rounds that must not pass, and the only checks that may fail.
// The retry-test core predates the single-live-request fix: both of its
// requests were fulfilled in one transaction, so the fulfilling node chose the
// seed (PUBLIC-SPEC §4 "No re-rolls").
const EXPECTED_FAILURES: Record<string, string[]> = {
  '97-fe9439c8.json round 1': ['vrf.oneSuccess'],
};

describe('recorded draws reproduce', () => {
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.json'))) {
    const rec = loadRecording(join(DIR, file));
    for (const round of rec.rounds) {
      const name = `${file} round ${round}`;
      const failures = EXPECTED_FAILURES[name];
      test(failures === undefined ? name : `${name} fails ${failures.join(', ')}, and nothing else`, async () => {
        const r = await run(rec, round);
        const notPassing = [...r.statuses].filter(([, s]) => s !== 'pass').map(([id, s]) => `${id}=${s}`);
        assert.deepEqual(notPassing, (failures ?? []).map((id) => `${id}=fail`));
      });
    }
  }
});

type RawLog = { address: string; topics: string[]; data: string; blockNumber: string; logIndex: string };

// Applies `edit` to every recorded copy of the first log of `name` (a log can
// appear in several recorded query results).
function tamper(rec: Recording, name: EventName, edit: (l: RawLog) => void, nth = 0): Recording {
  const copy = structuredClone(rec);
  const key = (l: RawLog): string => `${l.blockNumber}:${l.logIndex}`;
  const all = copy.exchanges.filter((e) => e.method === 'eth_getLogs').flatMap((e) => e.result as RawLog[]);
  const targetKey = [...new Set(all.filter((l) => l.topics[0] === topics[name]).map(key))][nth];
  assert.ok(targetKey !== undefined, `no ${name} log to tamper with`);
  for (const l of all) if (key(l) === targetKey) edit(l);
  return copy;
}

function selector(signature: string): string {
  return bytesToHex(keccak(new TextEncoder().encode(signature)).subarray(0, 4));
}

function setWord(data: string, index: number, value: string): string {
  const words = data.slice(2).match(/.{64}/g) as string[];
  words[index] = value.padStart(64, '0');
  return '0x' + words.join('');
}

describe('tampering is caught', () => {
  const rec = loadRecording(join(DIR, '97-a0ca23bf.json'));

  test('a purchase credited to a different buyer', async () => {
    const r = await run(tamper(rec, 'TicketsPurchased', (l) => { l.topics[2] = '0x' + '00'.repeat(12) + '11'.repeat(20); }), '1');
    assert.ok(r.failed.includes('commit.value'), r.failed.join());
  });

  test('a purchase log missing, as from a pruned endpoint', async () => {
    const r = await run(tamper(rec, 'TicketsPurchased', (l) => { l.topics[0] = '0x' + '00'.repeat(32); }), '1');
    assert.equal(r.statuses.get('entries.complete'), 'incomplete');
    assert.equal(r.status, 'incomplete');
  });

  test('a purchase after the commitment', async () => {
    const commit = tamper(rec, 'EntryCommitted', () => {});
    const commitLog = commit.exchanges.flatMap((e) => (e.method === 'eth_getLogs' ? (e.result as RawLog[]) : [])).find((l) => l.topics[0] === topics.EntryCommitted) as RawLog;
    const r = await run(tamper(rec, 'TicketsPurchased', (l) => { l.blockNumber = '0x' + (BigInt(commitLog.blockNumber) + 1n).toString(16); }, 2), '1');
    assert.ok(r.failed.includes('commit.final'), r.failed.join());
  });

  test('a seed that is not the hash of Chainlink\'s outputSeed', async () => {
    const r = await run(tamper(rec, 'RandomnessFulfilled', (l) => { l.data = setWord(l.data, 1, 'ab'.repeat(32)); }), '1');
    assert.ok(r.failed.includes('seed.fromChainlink'), r.failed.join());
  });

  test('a fulfilment the coordinator logged with success = false', async () => {
    const r = await run(tamper(rec, 'RandomWordsFulfilled', (l) => { l.data = setWord(l.data, 3, '0'); }), '1');
    assert.ok(r.failed.includes('vrf.noFailedFulfilment'), r.failed.join());
  });

  test('a different winning index announced', async () => {
    const r = await run(tamper(rec, 'WinnerSelected', (l) => { l.data = setWord(l.data, 1, '3'); }), '1');
    assert.ok(r.failed.includes('winner.index'), r.failed.join());
  });

  test('a different winner announced for the right index', async () => {
    const r = await run(tamper(rec, 'WinnerSelected', (l) => { l.topics[2] = '0x' + '00'.repeat(12) + '22'.repeat(20); }), '1');
    assert.ok(r.failed.includes('winner.owner'), r.failed.join());
  });

  test('an address topic with its top bytes set is refused, not truncated', async () => {
    await assert.rejects(run(tamper(rec, 'WinnerSelected', (l) => { l.topics[2] = '0x' + '22'.repeat(32); }), '1').then(() => {}), /not an address/);
  });

  test('a coordinator that is not Chainlink\'s', async () => {
    const copy = structuredClone(rec);
    const impostor = '0x' + '00'.repeat(12) + '33'.repeat(20);
    for (const e of copy.exchanges) {
      const p = e.params[0] as { data?: string; address?: string };
      if (e.method === 'eth_call' && p.data === selector('vrfCoordinator()')) e.result = impostor;
      if (e.method === 'eth_getLogs' && p.address?.toLowerCase() === '0xda3b641d438362c440ac5458c57e00a712b66700') {
        p.address = '0x' + '33'.repeat(20);
        e.result = [];
      }
    }
    const r = await run(copy, '1');
    assert.ok(r.failed.includes('vrf.coordinator'), r.failed.join());
    assert.ok(r.failed.includes('seed.fromChainlink'), r.failed.join());
  });

  test('a round cancelled after randomness was requested', async () => {
    const copy = structuredClone(rec);
    const query = copy.exchanges.find((e) => e.method === 'eth_getLogs' && (e.result as RawLog[]).some((l) => l.topics[0] === topics.WinnerSelected)) as { result: RawLog[] };
    const win = query.result.find((l) => l.topics[0] === topics.WinnerSelected) as RawLog;
    query.result.push({ ...win, topics: [topics.RoundCancelled, win.topics[1] as string], data: '0x', logIndex: '0x' + (BigInt(win.logIndex) + 100n).toString(16) });
    const r = await run(copy, '1');
    assert.ok(r.failed.includes('round.noCancelAfterRequest'), r.failed.join());
  });

  test('a query the endpoint never answered is an error, never an empty result', async () => {
    const copy = structuredClone(rec);
    copy.exchanges = copy.exchanges.filter((e) => e.method !== 'eth_getLogs');
    await assert.rejects(run(copy, '1').then(() => {}), /not in recording/);
  });
});

// An endpoint that answers with logs it was not asked for. The replay above
// behaves like an honest node, so this one is faked directly.
describe('a lying endpoint is refused', () => {
  const core = 0xa0ca23bfb669acad267a1acaf142cd4b3415e759n;
  const honest = {
    address: '0xa0ca23bfb669acad267a1acaf142cd4b3415e759',
    topics: [topics.EntryCommitted, '0x' + '1'.padStart(64, '0')],
    data: '0x' + '00'.repeat(96), blockNumber: '0x10', logIndex: '0x0',
  };
  const query = { address: core, names: ['EntryCommitted'] as EventName[], indexed: [1n], fromBlock: 1n, toBlock: 100n };
  const answering = (log: object) => ({ request: async () => [log] });

  test('an honest log decodes', async () => {
    assert.equal((await fetchLogs(answering(honest), topics, query)).length, 1);
  });
  for (const [what, log] of [
    ['from another contract', { ...honest, address: '0x' + '44'.repeat(20) }],
    ['for another round', { ...honest, topics: [topics.EntryCommitted, '0x' + '2'.padStart(64, '0')] }],
    ['of an event not asked for', { ...honest, topics: [topics.RoundCancelled, honest.topics[1]] }],
    ['outside the block range', { ...honest, blockNumber: '0x1000' }],
    ['removed by a reorg', { ...honest, removed: true }],
    ['with the wrong data length', { ...honest, data: '0x' + '00'.repeat(64) }],
  ] as const) {
    test(`a log ${what}`, async () => {
      await assert.rejects(fetchLogs(answering(log), topics, query), /does not match the query/);
    });
  }
});

// Refunds, built from the settled recording by rewriting its history. Each
// case is one way a round can end in a refund, honest or not (PUBLIC-SPEC §4
// "Refunds").
describe('refunds are judged', () => {
  const rec = loadRecording(join(DIR, '97-a0ca23bf.json'));
  const coordinator = '0xda3b641d438362c440ac5458c57e00a712b66700';
  const STATUS = { OPEN: 1n, CLOSING: 2n, DRAWING: 3n, DRAWN: 4n, REFUNDING: 5n };

  const isCore = (e: Recording['exchanges'][number]): boolean =>
    e.method === 'eth_getLogs' && (e.params[0] as { address: string }).address.toLowerCase() === rec.core.toLowerCase();
  const coreLogs = (r: Recording): RawLog[] => r.exchanges.filter(isCore).flatMap((e) => e.result as RawLog[]);

  // Removes core logs of the named events, and optionally every coordinator
  // fulfilment, then appends RoundRefunding(from) after the last core log
  // left, and sets roundOf()'s status word.
  function refunded(from: bigint, opts: { drop?: EventName[]; dropFulfilments?: boolean; state?: bigint; after?: EventName } = {}): Recording {
    const copy = structuredClone(rec);
    const dropped = new Set((opts.drop ?? []).map((n) => topics[n]));
    for (const e of copy.exchanges) {
      if (e.method !== 'eth_getLogs') continue;
      if (isCore(e)) e.result = (e.result as RawLog[]).filter((l) => !dropped.has(l.topics[0] as string));
      else if (opts.dropFulfilments === true && (e.params[0] as { address: string }).address.toLowerCase() === coordinator) e.result = [];
    }
    const remaining = coreLogs(copy).sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
    // By default the refund comes after every core log left; `after` places
    // it in the same block as that event, later in the block.
    const anchor = opts.after === undefined ? (remaining.at(-1) as RawLog) : (remaining.find((l) => l.topics[0] === topics[opts.after as EventName]) as RawLog);
    const logIndex = BigInt(anchor.logIndex) + 100n;
    const host = copy.exchanges.find((e) => isCore(e) && (e.result as RawLog[]).length > 0) as { result: RawLog[] };
    host.result.push({ ...anchor, topics: [topics.RoundRefunding, '0x' + '1'.padStart(64, '0')], data: '0x' + from.toString(16).padStart(64, '0'), logIndex: '0x' + logIndex.toString(16) });
    for (const e of copy.exchanges) {
      const p = e.params[0] as { data?: string };
      if (e.method === 'eth_call' && p.data?.startsWith(selector('roundOf(uint256)'))) e.result = setWord(e.result as string, 0, (opts.state ?? STATUS.REFUNDING).toString(16));
    }
    return copy;
  }
  const verdict = async (copy: Recording): Promise<{ status: Status; justified: Status | undefined; failed: string[] }> => {
    const r = await run(copy, '1');
    return { status: r.status, justified: r.statuses.get('refund.justified'), failed: r.failed };
  };

  test('from DRAWING with no seed and no fulfilment: honest', async () => {
    const r = await verdict(refunded(STATUS.DRAWING, { drop: ['RandomnessFulfilled', 'WinnerSelected'], dropFulfilments: true }));
    assert.equal(r.status, 'pass', r.failed.join());
    assert.equal(r.justified, 'pass');
  });

  test('from DRAWING after the coordinator accepted a fulfilment that stored no seed: a veto', async () => {
    const r = await verdict(refunded(STATUS.DRAWING, { drop: ['RandomnessFulfilled', 'WinnerSelected'] }));
    assert.equal(r.justified, 'fail');
    assert.equal(r.status, 'fail');
  });

  test('from DRAWING with a seed that yields a winner: not stranded', async () => {
    const r = await verdict(refunded(STATUS.DRAWING, { drop: ['WinnerSelected'] }));
    assert.equal(r.justified, 'fail');
  });

  test('from CLOSING before any request: honest', async () => {
    const r = await verdict(refunded(STATUS.CLOSING, { drop: ['RandomnessRequested', 'RandomnessFulfilled', 'WinnerSelected'] }));
    assert.equal(r.status, 'pass', r.failed.join());
    assert.equal(r.justified, 'pass');
  });

  test('from DRAWING before any request: impossible', async () => {
    const r = await verdict(refunded(STATUS.DRAWING, { drop: ['RandomnessRequested', 'RandomnessFulfilled', 'WinnerSelected'] }));
    assert.equal(r.justified, 'fail');
  });

  test('from OPEN after randomness was requested', async () => {
    const r = await verdict(refunded(STATUS.OPEN, { drop: ['RandomnessFulfilled', 'WinnerSelected'], dropFulfilments: true }));
    assert.equal(r.justified, 'fail');
  });

  test('from DRAWN with redraws left', async () => {
    const r = await verdict(refunded(STATUS.DRAWN));
    assert.equal(r.justified, 'fail');
  });

  test('draw activity after the refund', async () => {
    const r = await verdict(refunded(STATUS.DRAWING, { after: 'RandomnessRequested' }));
    assert.ok(r.failed.includes('refund.final'), r.failed.join());
  });

  test('state says refunding, but the endpoint has no RoundRefunding log', async () => {
    const copy = structuredClone(rec);
    for (const e of copy.exchanges) {
      const p = e.params[0] as { data?: string };
      if (e.method === 'eth_call' && p.data?.startsWith(selector('roundOf(uint256)'))) e.result = setWord(e.result as string, 0, '5');
    }
    const r = await run(copy, '1');
    assert.equal(r.statuses.get('state.refunding'), 'incomplete');
  });
});
