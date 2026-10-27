// Records what an endpoint answers while the verifier checks one or more
// rounds on a core, for replay in CI after public nodes prune those logs.
//
//   node scripts/record.ts --rpc <url> --core <address> --from-block <n> --rounds 1,2 --note "<what it exercises>" --out test/recorded/<file>.json
//
// Every round in one file is read at the same pinned block, so the recording
// is one consistent snapshot. The endpoint is stored as its host only, since
// provider URLs often carry an API key.

import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseDecimal, parseFixedHex } from '../src/hex.ts';
import { nodeKeccak256 } from '../src/node-keccak.ts';
import { overall } from '../src/report.ts';
import { describeEndpoint, httpRpc, type Rpc } from '../src/rpc.ts';
import { verifyRound } from '../src/verify.ts';

const { values: a } = parseArgs({
  options: {
    rpc: { type: 'string' }, core: { type: 'string' }, 'from-block': { type: 'string' },
    rounds: { type: 'string' }, note: { type: 'string' }, out: { type: 'string' },
  },
  strict: true,
});
if (!a.rpc || !a.core || !a['from-block'] || !a.rounds || !a.note || !a.out) {
  console.error('usage: record.ts --rpc <url> --core <address> --from-block <n> --rounds 1,2 --note <text> --out <file>');
  process.exit(2);
}

const live = httpRpc(a.rpc);
const exchanges: { method: string; params: unknown[]; result: unknown }[] = [];
let pinned: unknown;
const recording: Rpc = {
  async request(method, params) {
    if (method === 'eth_blockNumber' && pinned !== undefined) return pinned;
    const result = await live.request(method, params);
    if (method === 'eth_blockNumber') pinned = result;
    if (!exchanges.some((e) => e.method === method && JSON.stringify(e.params) === JSON.stringify(params))) {
      exchanges.push({ method, params: [...params], result });
    }
    return result;
  },
};

const keccak = nodeKeccak256();
const rounds = a.rounds.split(',');
for (const round of rounds) {
  const report = await verifyRound({ rpc: recording, keccak, core: parseFixedHex(a.core, 20), roundId: parseDecimal(round), fromBlock: parseDecimal(a['from-block']) });
  console.log(`round ${round}: ${overall(report)}`);
}
const chainId = exchanges.find((e) => e.method === 'eth_chainId')?.result;
writeFileSync(a.out, JSON.stringify({
  capturedAt: new Date().toISOString(), endpoint: describeEndpoint(a.rpc), chainId, block: pinned,
  core: a.core.toLowerCase(), fromBlock: a['from-block'], rounds, note: a.note, exchanges,
}, null, 1) + '\n');
console.log(`wrote ${a.out}: ${exchanges.length} exchanges at block ${BigInt(String(pinned))}`);
