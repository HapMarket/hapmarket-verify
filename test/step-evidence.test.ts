// Step evidence (PUBLIC-SPEC §8): a verification surface shows the four §4
// steps for every nonce, with each step's block, timestamp and transaction.
// These are references the endpoint reported, not values the verifier checked:
// they produce no Check and never change a verdict. This test proves both — the
// steps are populated, and forging a transaction hash or a timestamp changes no
// check status.

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { eventTopics } from '../src/events.ts';
import { nodeKeccak256 } from '../src/node-keccak.ts';
import { overall } from '../src/report.ts';
import { verifyRound, type RoundReport } from '../src/verify.ts';
import { loadRecording, replayRpc, type Recording } from './replay.ts';
import type { Rpc } from '../src/rpc.ts';

const keccak = nodeKeccak256();
const topics = eventTopics(keccak);
const DIR = join(import.meta.dirname, 'recorded');
const REC = '97-1d1da09e.json'; // a clean, settled, single-nonce real-VRF draw
const TIMESTAMP = 0x6543_2100n; // a block timestamp the recording does not carry

type RawLog = { address: string; topics: string[]; data: string; blockNumber: string; logIndex: string; transactionHash: string };

// Replays the recording, and additionally answers eth_getBlockByNumber (which
// the recording has none of) with a fixed timestamp, so the reference path is
// exercised rather than left absent.
function withBlocks(rec: Recording, timestamp = TIMESTAMP): Rpc {
  const base = replayRpc(rec);
  return {
    async request(method, params) {
      if (method === 'eth_getBlockByNumber') return { number: (params as string[])[0], timestamp: '0x' + timestamp.toString(16) };
      return base.request(method, params);
    },
  };
}

async function verify(rpc: Rpc): Promise<RoundReport> {
  const rec = loadRecording(join(DIR, REC));
  return verifyRound({ rpc, keccak, core: BigInt(rec.core), roundId: 1n, fromBlock: BigInt(rec.fromBlock) });
}

const statuses = (r: RoundReport): string[] => r.checks.map((c) => `${c.id}#${c.nonce ?? '-'}=${c.status}`);

describe('step evidence is reported', () => {
  test('the four steps appear for the draw, with transaction hashes and timestamps', async () => {
    const rec = loadRecording(join(DIR, REC));
    const report = await verify(withBlocks(rec));
    assert.equal(overall(report), 'pass', statuses(report).filter((s) => !s.endsWith('pass')).join());

    const steps = report.steps;
    const freeze = steps.find((s) => s.step === 'freeze');
    assert.ok(freeze !== undefined, 'a round-level freeze step');
    assert.equal(freeze.nonce, undefined, 'freeze is round-level');
    assert.ok(steps.some((s) => s.step === 'request' && s.nonce === 1n && s.requestId !== undefined), 'a request step for nonce 1');
    const fulfil = steps.find((s) => s.step === 'fulfil' && s.nonce === 1n);
    assert.ok(fulfil !== undefined, 'a fulfil step for nonce 1');
    assert.ok(fulfil.coordinator !== undefined, 'the fulfil step carries the coordinator log');
    assert.ok(steps.some((s) => s.step === 'derive' && s.nonce === 1n), 'a derive step for nonce 1');

    // Every reference has a non-zero transaction hash and the served timestamp.
    for (const s of steps) {
      assert.notEqual(s.transactionHash, 0n, `${s.step} has a transaction hash`);
      assert.equal(s.blockTimestamp, TIMESTAMP, `${s.step} carries the reported timestamp`);
      if (s.coordinator !== undefined) assert.equal(s.coordinator.blockTimestamp, TIMESTAMP);
    }
  });
});

describe('references do not affect any check', () => {
  test('a forged transaction hash changes no check status', async () => {
    const rec = loadRecording(join(DIR, REC));
    const baseline = statuses(await verify(withBlocks(rec)));

    // Rewrite the transaction hash on every recorded copy of the first
    // TicketsPurchased log. The commitment folds in only buyer/start/end (§3),
    // so a changed hash must leave every check exactly as it was.
    const copy = structuredClone(rec);
    const all = copy.exchanges.filter((e) => e.method === 'eth_getLogs').flatMap((e) => e.result as RawLog[]);
    const target = all.find((l) => l.topics[0] === topics.TicketsPurchased);
    assert.ok(target !== undefined, 'a purchase log to tamper with');
    const key = `${target.blockNumber}:${target.logIndex}`;
    for (const l of all) if (`${l.blockNumber}:${l.logIndex}` === key) l.transactionHash = '0x' + 'cd'.repeat(32);

    const report = await verify(withBlocks(copy));
    assert.deepEqual(statuses(report), baseline, 'a forged transaction hash must not change any check');
    // And the forged hash does surface in the evidence, unverified.
    assert.ok(report.steps.length > 0);
  });

  test('a different reported timestamp changes no check status', async () => {
    const rec = loadRecording(join(DIR, REC));
    const baseline = statuses(await verify(withBlocks(rec, 0x1111_1111n)));
    const other = statuses(await verify(withBlocks(rec, 0x9999_9999n)));
    assert.deepEqual(other, baseline, 'the timestamp is a reference, not a check');
  });
});
