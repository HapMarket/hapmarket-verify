import { coordinatorFor } from './chainlink.ts';
import { computeCommitment, type Purchase } from './commitment.ts';
import { deriveIndex, isExcluded, MAX_ATTEMPTS, type Derivation, type Range } from './derivation.ts';
import { hashDescriptor } from './descriptor.ts';
import { chainOrder, eventTopics, fetchLogs, orderPurchases, purchaseFromLog, type EventName, type Log } from './events.ts';
import { bytesToHex, hex32, hexAddress, hexToBytes, toWord } from './hex.ts';
import type { Keccak256 } from './keccak.ts';
import { parseQuantity, quantity, type Rpc } from './rpc.ts';
import { seedFromOutputSeed } from './seed.ts';

// Verifies one round, on one core, across every draw nonce, following
// PUBLIC-SPEC §8. Every comparison is recorded with both values, pass or fail,
// so a reader can see what was checked rather than take a verdict on trust.
//
// The run is pinned to one block, read once at the start. Every log is
// fetched up to that block and every state call is made at it, so logs and
// state describe the same moment and a draw finishing mid-run cannot make
// them disagree.

// pass         the values agree
// fail         they do not: the draw, as recorded on-chain, does not check out
// incomplete   the endpoint did not supply data the check needs (most often a
//              pruned endpoint); nothing was proven either way
// pending      the draw has not reached this step yet
// unverifiable a prize descriptor newer than this tool (PUBLIC-SPEC §9)
export type Status = 'pass' | 'fail' | 'incomplete' | 'pending' | 'unverifiable';

export interface Check {
  id: string;
  title: string;
  status: Status;
  nonce?: bigint;
  expected?: string;
  actual?: string;
  note?: string;
}

export interface RoundReport {
  chainId: bigint;
  core: bigint;
  roundId: bigint;
  block: bigint;
  checks: Check[];
}

export interface VerifyInput {
  rpc: Rpc;
  keccak: Keccak256;
  core: bigint;
  roundId: bigint;
  fromBlock: bigint;
  // Optional prize descriptor text, checked against the hash the round
  // committed to when it opened.
  descriptor?: Uint8Array;
}

const MAX_NONCES = 3n; // the original draw and at most two redraws (PUBLIC-SPEC §4, §6)

// roundOf()'s status word, and RoundRefunding's `from` (PUBLIC-SPEC §10).
const STATUS_NAMES = ['NONE', 'OPEN', 'CLOSING', 'DRAWING', 'DRAWN', 'REFUNDING', 'FULFILLING', 'SETTLED'] as const;
const OPEN = 1n;
const CLOSING = 2n;
const DRAWING = 3n;
const DRAWN = 4n;
const REFUNDING = 5n;
const statusName = (s: bigint): string => (s < BigInt(STATUS_NAMES.length) ? (STATUS_NAMES[Number(s)] as string) : `unknown status ${s}`);

// Logs that only a draw in progress emits; none may follow a refund.
const DRAW_EVENTS: readonly EventName[] = ['RandomnessRequested', 'RandomnessFulfilled', 'WinnerSelected'];

const CORE_EVENTS: readonly EventName[] = [
  'RoundOpened', 'TicketsPurchased', 'EntryCommitted', 'RandomnessRequested',
  'RandomnessFulfilled', 'WinnerSelected', 'DrawForfeited', 'RoundCancelled', 'RoundRefunding',
];

export async function verifyRound(input: VerifyInput): Promise<RoundReport> {
  const { rpc, keccak, core, roundId } = input;
  const topics = eventTopics(keccak);
  const chainId = parseQuantity(await rpc.request('eth_chainId', []), 'eth_chainId');
  const block = parseQuantity(await rpc.request('eth_blockNumber', []), 'eth_blockNumber');
  const report: RoundReport = { chainId, core, roundId, block, checks: [] };
  const checks = report.checks;
  const push = (c: Check): void => void checks.push(c);
  const compare = (id: string, title: string, expected: string, actual: string, extra: Partial<Check> = {}): boolean => {
    push({ id, title, status: expected === actual ? 'pass' : 'fail', expected, actual, ...extra });
    return expected === actual;
  };

  const call = async (signature: string, args: readonly bigint[], words: number): Promise<bigint[]> => {
    const selector = bytesToHex(keccak(new TextEncoder().encode(signature)).subarray(0, 4));
    const data = selector + args.map((a) => bytesToHex(toWord(a)).slice(2)).join('');
    const result = await rpc.request('eth_call', [{ to: hexAddress(core), data }, quantity(block)]);
    const bytes = hexToBytes(String(result));
    if (bytes.length !== 32 * words) throw new Error(`${signature} returned ${bytes.length} bytes, expected ${32 * words}`);
    return Array.from({ length: words }, (_, i) => BigInt(bytesToHex(bytes.subarray(32 * i, 32 * i + 32))));
  };

  const logs = await fetchLogs(rpc, topics, { address: core, names: CORE_EVENTS, indexed: [roundId], fromBlock: input.fromBlock, toBlock: block });
  const of = (name: EventName): Log[] => logs.filter((l) => l.name === name).sort(chainOrder);
  const [status, stateNonce, stateCommitBlock, stateTotal, stateCommitment] = (await call('roundOf(uint256)', [roundId], 5)) as [bigint, bigint, bigint, bigint, bigint];

  // --- The round exists, and the endpoint has its history ---------------
  const opened = of('RoundOpened');
  if (opened.length === 0) {
    push(status === 0n
      ? { id: 'round.exists', title: 'Round exists on this core', status: 'fail', note: `no round ${roundId} on core ${hexAddress(core)}` }
      : { id: 'round.exists', title: 'Round exists on this core', status: 'incomplete',
          note: 'the core reports this round, but the endpoint returned no RoundOpened log: it has likely pruned old logs. Use an endpoint that serves full log history.' });
    return report;
  }
  const descriptorHash = (opened[0] as Log).words[1] as bigint;
  push({ id: 'round.exists', title: 'Round exists on this core', status: 'pass', actual: `opened in block ${(opened[0] as Log).blockNumber}` });
  if (input.descriptor !== undefined) checkDescriptor(keccak, input.descriptor, descriptorHash, push);

  // --- Refund (PUBLIC-SPEC §4 "Refunds") ----------------------------------
  // A refund voids the round, so it needs a reason as much as a winner does:
  // refunding a draw whose outcome was already readable is a veto. Whether the
  // reason holds is judged once the rest of the round is known (refund.justified
  // below); here, that there is at most one, and that state agrees.
  const refunds = of('RoundRefunding');
  if (refunds.length > 1) {
    push({ id: 'refund.once', title: 'Refunded at most once', status: 'fail', actual: `${refunds.length} RoundRefunding logs` });
    return report;
  }
  const refund = refunds[0];
  push({ id: 'state.refunding', title: 'Refunding: RoundRefunding log vs roundOf() status now',
    status: (status === REFUNDING) === (refund !== undefined) ? 'pass' : refund === undefined ? 'incomplete' : 'fail',
    expected: refund === undefined ? 'not REFUNDING' : 'REFUNDING', actual: statusName(status),
    ...(refund === undefined && status === REFUNDING ? { note: 'the core reports a refund, but the endpoint returned no RoundRefunding log' } : {}) });
  const judgeRefund = (r: Log, ok: boolean, reason: string): void => {
    push({ id: 'refund.justified', title: 'Refund has a reason the chain shows', status: ok ? 'pass' : 'fail',
      actual: `refunded from ${statusName(r.words[0] as bigint)} in block ${r.blockNumber}`, note: reason });
  };
  // Before any request there is no outcome to void, so only a refund from
  // OPEN or CLOSING is honest; the core cannot be in a later status yet.
  const judgeRefundBeforeDraw = (r: Log): void => {
    const from = r.words[0] as bigint;
    judgeRefund(r, from === OPEN || from === CLOSING, from === OPEN || from === CLOSING
      ? 'no randomness was ever requested, so there was no outcome to void'
      : `no randomness was ever requested, so the round cannot have been ${statusName(from)}`);
  };

  // --- Coordinator: Chainlink's, per Chainlink's own documentation -------
  const known = coordinatorFor(chainId);
  const [coordinatorWord] = await call('vrfCoordinator()', [], 1);
  const coordinator = coordinatorWord as bigint;
  if (known === undefined) {
    push({ id: 'vrf.coordinator', title: "Core's VRF coordinator is Chainlink's", status: 'incomplete', actual: hexAddress(coordinator),
      note: `this verifier has no Chainlink coordinator on record for chain ${chainId}` });
  } else {
    compare('vrf.coordinator', "Core's VRF coordinator is Chainlink's", hexAddress(known.address), hexAddress(coordinator),
      { note: `expected value: ${known.source}, retrieved ${known.retrieved}` });
  }

  // --- Commitment (PUBLIC-SPEC §3, §8 steps 1–5) ---------------------------
  const committed = of('EntryCommitted');
  if (committed.length === 0) {
    if (refund !== undefined && stateCommitBlock === 0n) {
      judgeRefundBeforeDraw(refund);
      return report;
    }
    push(stateCommitBlock === 0n
      ? { id: 'commit.exists', title: 'Entries committed', status: 'pending', note: 'the round has not closed yet' }
      : { id: 'commit.exists', title: 'Entries committed', status: 'incomplete',
          note: `the core reports a commitment at block ${stateCommitBlock}, but the endpoint returned no EntryCommitted log` });
    return report;
  }
  if (committed.length > 1) {
    push({ id: 'commit.once', title: 'Commitment emitted exactly once', status: 'fail', actual: `${committed.length} EntryCommitted logs` });
    return report;
  }
  const commitLog = committed[0] as Log;
  const [commitment, committedTotal, commitBlock] = commitLog.words as [bigint, bigint, bigint];
  push({ id: 'commit.once', title: 'Commitment emitted exactly once', status: 'pass' });

  const purchaseLogs = of('TicketsPurchased');
  const late = purchaseLogs.filter((p) => chainOrder(p, commitLog) > 0);
  push({ id: 'commit.final', title: 'No purchase after the commitment', status: late.length === 0 ? 'pass' : 'fail',
    ...(late.length > 0 ? { actual: `${late.length} purchase(s) after block ${commitLog.blockNumber}` } : {}) });

  const ordered = orderPurchases(purchaseLogs.map(purchaseFromLog));
  const recomputed = computeCommitment(keccak, ordered);
  const tiling = findTilingDefect(ordered, committedTotal);
  if (recomputed.totalTickets < committedTotal) {
    push({ id: 'entries.complete', title: 'Purchase logs cover every committed ticket', status: 'incomplete',
      expected: committedTotal.toString(), actual: recomputed.totalTickets.toString(),
      note: 'purchase logs are missing: the endpoint has likely pruned old logs. If a full-history endpoint shows the same, the contract committed to entries it never emitted, which is a failure.' });
    return report;
  }
  push({ id: 'entries.tiling', title: 'Purchase ranges tile 0 … totalTickets-1 with no gap or overlap', status: tiling === undefined ? 'pass' : 'fail',
    ...(tiling !== undefined ? { actual: tiling } : {}) });
  compare('commit.total', 'Total tickets: recomputed vs EntryCommitted', committedTotal.toString(), recomputed.totalTickets.toString());
  compare('commit.value', 'Commitment: recomputed from purchases vs EntryCommitted', hex32(commitment), hex32(recomputed.commitment),
    { note: `${ordered.length} purchase(s), folded from bytes32(0) in block/log order` });
  compare('commit.block', 'commitBlock field vs block of the EntryCommitted log', commitLog.blockNumber.toString(), commitBlock.toString());
  compare('state.commitment', 'Commitment: EntryCommitted vs roundOf() now', hex32(commitment), hex32(stateCommitment));
  compare('state.total', 'Total tickets: EntryCommitted vs roundOf() now', committedTotal.toString(), stateTotal.toString());
  compare('state.commitBlock', 'Commit block: EntryCommitted vs roundOf() now', commitBlock.toString(), stateCommitBlock.toString());

  // --- Requests (PUBLIC-SPEC §4, §8 step 4) --------------------------------
  const requests = of('RandomnessRequested').map((l) => ({ log: l, nonce: l.words[0] as bigint, requestId: l.topics[1] as bigint }));
  for (const r of requests) {
    push({ id: 'request.afterCommit', title: 'Request is in a later block than the commitment', nonce: r.nonce,
      status: r.log.blockNumber > commitBlock ? 'pass' : 'fail', expected: `> ${commitBlock}`, actual: r.log.blockNumber.toString(),
      note: `requestId ${r.requestId}` });
  }
  const cancelled = of('RoundCancelled');
  if (cancelled.length > 0) {
    const afterRequest = requests.length > 0 && cancelled.some((c) => chainOrder(c, (requests[0] as { log: Log }).log) > 0);
    push({ id: 'round.noCancelAfterRequest', title: 'Not cancelled after randomness was requested', status: afterRequest ? 'fail' : 'pass',
      actual: `cancelled in block ${(cancelled[0] as Log).blockNumber}` });
  }
  if (requests.length === 0) {
    if (refund !== undefined) {
      judgeRefundBeforeDraw(refund);
      return report;
    }
    push({ id: 'draw.requested', title: 'Randomness requested', status: 'pending', note: 'committed, but no request yet' });
    return report;
  }
  const maxNonce = requests.reduce((m, r) => (r.nonce > m ? r.nonce : m), 0n);
  const missing = Array.from({ length: Number(maxNonce) }, (_, i) => BigInt(i + 1)).filter((n) => !requests.some((r) => r.nonce === n));
  push({ id: 'nonce.complete', title: 'Draw nonces run 1, 2, … with no gap, at most 3', status: missing.length === 0 && maxNonce <= MAX_NONCES ? 'pass' : 'fail',
    actual: `nonces seen up to ${maxNonce}${missing.length ? `, missing ${missing.join(', ')}` : ''}` });
  compare('state.nonce', 'Current nonce: logs vs roundOf() now', maxNonce.toString(), stateNonce.toString());

  // --- Each request's fulfilment, from the coordinator itself (§8 steps 6–7)
  const fulfilmentByRequest = new Map<bigint, Log>();
  for (const r of requests) {
    const found = await fetchLogs(rpc, topics, { address: coordinator, names: ['RandomWordsFulfilled'], indexed: [r.requestId], fromBlock: r.log.blockNumber, toBlock: block });
    if (found.length > 1) {
      push({ id: 'vrf.single', title: 'Coordinator fulfilled the request at most once', nonce: r.nonce, status: 'fail', actual: `${found.length} fulfilments of ${r.requestId}` });
      continue;
    }
    const f = found[0];
    if (f === undefined) continue;
    fulfilmentByRequest.set(r.requestId, f);
    // A failed fulfilment still published its outputSeed, so a later seed for
    // the same nonce was drawn after one outcome was already known (§4).
    push({ id: 'vrf.noFailedFulfilment', title: 'Fulfilment did not fail (success = true)', nonce: r.nonce,
      status: f.words[3] === 1n ? 'pass' : 'fail', actual: `success = ${f.words[3] === 1n}`, note: `requestId ${r.requestId}` });
  }

  // --- Each draw nonce (§5, §6, §8 steps 7–9) ------------------------------
  const winners = of('WinnerSelected');
  const forfeits = of('DrawForfeited');
  const winnerOf = new Map<bigint, Log>();
  const derivedOf = new Map<bigint, Derivation>();
  const accepted = (n: bigint): typeof requests => requests.filter((r) => r.nonce === n && fulfilmentByRequest.get(r.requestId)?.words[3] === 1n);
  for (let n = 1n; n <= maxNonce; n++) {
    // Two accepted fulfilments for one nonce mean two outcomes were live at
    // once, and whoever ordered them (in practice the fulfilling node, which
    // batches them into one transaction) chose the seed (§4 "No re-rolls").
    const ofNonce = requests.filter((r) => r.nonce === n);
    const live = accepted(n);
    push({ id: 'vrf.oneSuccess', title: "At most one of the nonce's requests fulfilled successfully", nonce: n,
      status: live.length <= 1 ? 'pass' : 'fail', actual: `${live.length} of ${ofNonce.length} request(s)`,
      ...(live.length > 1 ? { note: `requests ${live.map((r) => r.requestId).join(', ')} were all fulfilled: whoever ordered them chose between ${live.length} known outcomes` } : {}) });

    const wins = winners.filter((w) => w.words[0] === n);
    const fulfilled = of('RandomnessFulfilled').filter((f) => f.words[0] === n);
    if (fulfilled.length > 1) {
      push({ id: 'seed.once', title: 'One seed per nonce', nonce: n, status: 'fail', actual: `${fulfilled.length} RandomnessFulfilled logs` });
      continue;
    }
    const fulfilment = fulfilled[0];
    if (fulfilment === undefined) {
      if (refund !== undefined && wins.length === 0) continue; // refund.justified decides this nonce
      push({ id: 'seed.delivered', title: 'Seed delivered', nonce: n, status: wins.length > 0 ? 'fail' : 'pending',
        note: wins.length > 0 ? 'a winner was announced with no seed' : 'requested, not yet fulfilled' });
      continue;
    }
    const requestId = fulfilment.topics[1] as bigint;
    const seed = fulfilment.words[1] as bigint;
    const ofThisNonce = requests.some((r) => r.nonce === n && r.requestId === requestId);
    push({ id: 'seed.requestMatches', title: "Seed's requestId was requested for this nonce", nonce: n, status: ofThisNonce ? 'pass' : 'fail', actual: requestId.toString() });

    const vrf = fulfilmentByRequest.get(requestId);
    if (vrf === undefined) {
      push({ id: 'seed.fromChainlink', title: "Seed equals keccak256(abi.encode(outputSeed, 0)) from the coordinator's log", nonce: n, status: 'fail',
        note: `no RandomWordsFulfilled for requestId ${requestId} from ${hexAddress(coordinator)}` });
    } else {
      compare('seed.fromChainlink', "Seed equals keccak256(abi.encode(outputSeed, 0)) from the coordinator's log",
        hex32(seedFromOutputSeed(keccak, vrf.words[0] as bigint).seed), hex32(seed), { nonce: n, note: `outputSeed ${hex32(vrf.words[0] as bigint)}` });
      compare('seed.sameTx', 'Seed stored in the same block the coordinator fulfilled it', vrf.blockNumber.toString(), fulfilment.blockNumber.toString(), { nonce: n });
    }

    // Excluded set from chain events alone: every range of every earlier
    // winner (§8, "Deriving the excluded set without trusting anyone").
    const excluded: Range[] = [];
    for (let k = 1n; k < n; k++) {
      const earlier = winnerOf.get(k);
      if (earlier === undefined) {
        push({ id: 'redraw.priorWinner', title: 'Earlier nonce has a winner', nonce: n, status: 'fail', note: `nonce ${k} has no WinnerSelected` });
        continue;
      }
      const forfeiter = earlier.topics[1] as bigint;
      excluded.push(...ordered.filter((p) => p.buyer === forfeiter));
      if (k !== n - 1n) continue;
      const forfeit = forfeits.find((f) => f.words[0] === k);
      compare('redraw.forfeitMatches', 'DrawForfeited names the earlier winner', hexAddress(forfeiter),
        forfeit === undefined ? '(no DrawForfeited log)' : hexAddress(forfeit.topics[1] as bigint), { nonce: n });
    }

    const derived = deriveIndex(keccak, seed, roundId, n, committedTotal, excluded);
    derivedOf.set(n, derived);
    if (wins.length > 1) {
      push({ id: 'winner.once', title: 'One winner per nonce', nonce: n, status: 'fail', actual: `${wins.length} WinnerSelected logs` });
      continue;
    }
    const win = wins[0];
    if (win === undefined) {
      if (refund !== undefined) continue; // refund.justified decides this nonce
      push({ id: 'winner.selected', title: 'Winner selected', nonce: n, status: 'pending',
        note: derived.outcome === 'index' ? `seed delivered; the index it yields is ${derived.index}` : 'seed delivered; no eligible index (the round becomes refundable)' });
      continue;
    }
    winnerOf.set(n, win);
    const announcedIndex = win.words[1] as bigint;
    const announcedWinner = win.topics[1] as bigint;
    if (derived.outcome === 'revert') {
      push({ id: 'winner.index', title: 'Winning index: derived vs announced', nonce: n, status: 'fail', expected: 'NoEligibleIndex', actual: announcedIndex.toString() });
      continue;
    }
    compare('winner.index', 'Winning index: derived vs announced', derived.index.toString(), announcedIndex.toString(),
      { nonce: n, note: `${derived.attempts + 1n} attempt(s), ${excluded.length} excluded range(s)` });
    push({ id: 'winner.notExcluded', title: 'Announced index is not excluded', nonce: n, status: isExcluded(announcedIndex, excluded) ? 'fail' : 'pass' });
    const owner = ownerOf(ordered, announcedIndex);
    compare('winner.owner', 'Owner of the announced index vs announced winner', owner === undefined ? '(no owner)' : hexAddress(owner), hexAddress(announcedWinner), { nonce: n });

    const [, , , , , dWinner, dIndex, dRequestId, dSeed] = await call('drawOf(uint256,uint256)', [roundId, n], 9);
    compare('state.draw', 'Draw: logs vs drawOf() now (winner, index, requestId, seed)',
      [hexAddress(announcedWinner), announcedIndex, requestId, hex32(seed)].join(' '),
      [hexAddress(dWinner as bigint), dIndex, dRequestId, hex32(dSeed as bigint)].join(' '), { nonce: n });
  }

  if (refund !== undefined) {
    judgeRefund(refund, ...refundReason(refund.words[0] as bigint));
    const after = logs.filter((l) => DRAW_EVENTS.includes(l.name) && chainOrder(l, refund) > 0);
    push({ id: 'refund.final', title: 'No draw activity after the refund', status: after.length === 0 ? 'pass' : 'fail',
      ...(after.length > 0 ? { actual: after.map((l) => `${l.name} in block ${l.blockNumber}`).join(', ') } : {}) });
  }
  return report;

  // The rule for each status a round can refund from, once randomness was
  // requested (PUBLIC-SPEC §4 "Refunds").
  function refundReason(from: bigint): [boolean, string] {
    if (from === OPEN || from === CLOSING) return [false, 'randomness was requested for this round, so it was past CLOSING'];
    if (from === DRAWING) {
      const n = maxNonce;
      if (winnerOf.has(n)) return [false, `nonce ${n} already has a winner`];
      const derived = derivedOf.get(n);
      // A stored seed: only a seed that yields no eligible index strands the draw.
      if (derived !== undefined) {
        return derived.outcome === 'revert'
          ? [true, `nonce ${n}'s seed yields no eligible index (NoEligibleIndex after ${MAX_ATTEMPTS} attempts)`]
          : [false, `nonce ${n}'s seed yields index ${derived.index}: the draw could have completed`];
      }
      // No stored seed: honest only if no request could ever deliver one. A
      // fulfilment the coordinator accepted, with no seed stored, landed after
      // the refund, and its outcome was readable from the pending transaction
      // before that: the refund could have been a veto.
      const live = accepted(n);
      if (live.length === 0) return [true, `nonce ${n} holds no seed, and the coordinator accepted no fulfilment of its ${requests.filter((r) => r.nonce === n).length} request(s)`];
      const late = fulfilmentByRequest.get((live[0] as { requestId: bigint }).requestId) as Log;
      return [false, `the coordinator accepted a fulfilment of request ${(live[0] as { requestId: bigint }).requestId} in block ${late.blockNumber}, but no seed was stored: the round refunded while that outcome was on its way`];
    }
    if (from === DRAWN) {
      const last = winnerOf.get(MAX_NONCES);
      const forfeit = forfeits.find((f) => f.words[0] === MAX_NONCES);
      if (maxNonce !== MAX_NONCES || last === undefined) return [false, `only the winner of the last nonce (${MAX_NONCES}) forfeiting refunds a drawn round; the round reached nonce ${maxNonce}`];
      if (forfeit === undefined || forfeit.topics[1] !== last.topics[1] || chainOrder(forfeit, refund as Log) > 0) {
        return [false, `no DrawForfeited for nonce ${MAX_NONCES} naming its winner ${hexAddress(last.topics[1] as bigint)} before the refund`];
      }
      return [true, `the winner of nonce ${MAX_NONCES}, ${hexAddress(last.topics[1] as bigint)}, forfeited, and every redraw is used`];
    }
    return [false, `no round refunds from ${statusName(from)}`];
  }
}

// Returns a description of the first defect, or undefined if the ranges
// tile [0, total) exactly in purchase order (PUBLIC-SPEC §8).
export function findTilingDefect(ordered: readonly Purchase[], total: bigint): string | undefined {
  let next = 0n;
  for (const p of ordered) {
    if (p.startIndex !== next) return `range (${p.startIndex}, ${p.endIndex}) at block ${p.blockNumber} should start at ${next}`;
    next = p.endIndex + 1n;
  }
  return next === total ? undefined : `ranges end at ${next - 1n}, totalTickets is ${total}`;
}

// Binary search over ranges that tile the round in ascending order (§5).
export function ownerOf(ordered: readonly Purchase[], index: bigint): bigint | undefined {
  let lo = 0;
  let hi = ordered.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = ordered[mid] as Purchase;
    if (index < p.startIndex) hi = mid - 1;
    else if (index > p.endIndex) lo = mid + 1;
    else return p.buyer;
  }
  return undefined;
}

function checkDescriptor(keccak: Keccak256, bytes: Uint8Array, committed: bigint, push: (c: Check) => void): void {
  const title = 'Prize descriptor hashes to the value committed at round opening';
  const r = hashDescriptor(keccak, bytes);
  if (r.outcome === 'hash') {
    push({ id: 'descriptor.hash', title, status: r.hash === committed ? 'pass' : 'fail', expected: hex32(committed), actual: hex32(r.hash) });
  } else if (r.outcome === 'reject') {
    push({ id: 'descriptor.hash', title, status: 'fail', expected: hex32(committed), actual: `rejected at ${r.stage}: ${r.reason}` });
  } else {
    push({ id: 'descriptor.hash', title, status: 'unverifiable', expected: hex32(committed),
      note: `descriptor declares schemaVersion ${r.foundVersion}; this verifier supports ${r.supportedVersions.join(', ')}` });
  }
}
