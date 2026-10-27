#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { defaultCoreFor } from './deployments.ts';
import { parseDecimal, parseFixedHex } from './hex.ts';
import { nodeKeccak256 } from './node-keccak.ts';
import { EXIT, formatReport, overall } from './report.ts';
import { describeEndpoint, httpRpc, parseQuantity } from './rpc.ts';
import { verifyRound } from './verify.ts';

const USAGE = `Usage: hapmarket-verify --rpc <url> --round <id> [--core <address> --from-block <n>] [--descriptor <file>]

  --rpc         JSON-RPC endpoint that serves the chain's full log history.
                Any provider works; none of them needs to be the operator's.
  --round       Round ID on that core.
  --core        Core contract address. Defaults to the chain's current core
                (PUBLIC-SPEC.md §10). Use it for a superseded core.
  --from-block  Block the core was created in. Required with --core.
  --descriptor  Prize descriptor file, checked against the hash the round
                committed to.

Exit status: 0 pass, 1 fail, 2 usage or tool error, 3 incomplete data,
4 draw still in progress, 5 descriptor unverifiable by this version.`;

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({
      options: {
        rpc: { type: 'string' }, round: { type: 'string' }, core: { type: 'string' },
        'from-block': { type: 'string' }, descriptor: { type: 'string' }, help: { type: 'boolean' },
      },
      strict: true,
    }).values;
  } catch (e) {
    console.error(`${e instanceof Error ? e.message : String(e)}\n\n${USAGE}`);
    return EXIT.usage;
  }
  if (args.help === true) {
    console.log(USAGE);
    return EXIT.pass;
  }
  if (args.rpc === undefined || args.round === undefined || (args.core === undefined) !== (args['from-block'] === undefined)) {
    console.error(USAGE);
    return EXIT.usage;
  }

  const keccak = nodeKeccak256();
  const rpc = httpRpc(args.rpc);
  let core: bigint;
  let fromBlock: bigint;
  if (args.core !== undefined && args['from-block'] !== undefined) {
    core = parseFixedHex(args.core, 20);
    fromBlock = parseDecimal(args['from-block']);
  } else {
    const chainId = parseQuantity(await rpc.request('eth_chainId', []), 'eth_chainId');
    const d = defaultCoreFor(chainId);
    if (d === undefined) {
      console.error(`No default core for chain ${chainId}; pass --core and --from-block.`);
      return EXIT.usage;
    }
    core = d.core;
    fromBlock = d.fromBlock;
  }
  const report = await verifyRound({
    rpc, keccak, core, fromBlock,
    roundId: parseDecimal(args.round),
    ...(args.descriptor !== undefined ? { descriptor: new Uint8Array(readFileSync(args.descriptor)) } : {}),
  });
  console.log(formatReport(report, describeEndpoint(args.rpc)));
  return EXIT[overall(report)];
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(EXIT.usage);
  },
);
