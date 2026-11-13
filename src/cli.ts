#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { defaultCoreFor } from './deployments.ts';
import { entryListCsv, entryListJson } from './entries.ts';
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
  --entries     Write the reconstructed entry list (PUBLIC-SPEC §7) to this
                file. A .json or .csv extension selects the form; the bytes are
                byte-identical to the operator's published file for the round.

Exit status: 0 pass, 1 fail, 2 usage or tool error, 3 incomplete data,
4 draw still in progress, 5 descriptor unverifiable by this version.`;

async function main(): Promise<number> {
  let args;
  try {
    args = parseArgs({
      options: {
        rpc: { type: 'string' }, round: { type: 'string' }, core: { type: 'string' },
        'from-block': { type: 'string' }, descriptor: { type: 'string' }, entries: { type: 'string' },
        help: { type: 'boolean' },
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
  if (args.entries !== undefined) writeEntries(args.entries, report);
  return EXIT[overall(report)];
}

// Writes the reconstructed entry list (PUBLIC-SPEC §7) to a file, in the form
// its extension selects. The list is written even when a check failed — a
// failing list is exactly what a reader wants to inspect — but only once the
// commitment is known, since the envelope comes from the EntryCommitted log.
// A write failure never changes the verification result, so it is reported to
// stderr and the exit status is still the draw's.
function writeEntries(path: string, report: Awaited<ReturnType<typeof verifyRound>>): void {
  if (report.entryEnvelope === undefined) {
    console.error(`Not writing ${path}: the round has no committed entry list yet.`);
    return;
  }
  const lower = path.toLowerCase();
  const text = lower.endsWith('.csv') ? entryListCsv(report.entries)
    : lower.endsWith('.json') ? entryListJson(report.entryEnvelope, report.entries)
    : undefined;
  if (text === undefined) {
    console.error(`Not writing ${path}: use a .json or .csv extension.`);
    return;
  }
  writeFileSync(path, text);
  console.error(`Wrote ${report.entries.length} entr${report.entries.length === 1 ? 'y' : 'ies'} to ${path}`);
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(`Error: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(EXIT.usage);
  },
);
