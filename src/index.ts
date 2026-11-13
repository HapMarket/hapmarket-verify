// The library entry point, for a consumer that runs the verifier somewhere
// other than this CLI — hapmarket-web runs it in the browser (CLAUDE.md,
// "Publishing"). Nothing reachable from here imports `node:`: the platform
// pieces that do (node-keccak.ts, cli.ts) are never imported below, and a test
// walks this module's import graph and fails on any `node:` specifier.
//
// A browser consumer injects its own keccak256 (the web passes viem's) as the
// `keccak` of VerifyInput, and should first run it through checkKeccak256, the
// same known-answer self-test the CLI runs on Node's implementation.

export { verifyRound } from './verify.ts';
export type {
  Check, CheckId, NoteKey, RoundReport, Status, StepEvidence, StepName, StepRef, VerifyInput,
} from './verify.ts';
export { CHECK_IDS, NOTE_KEYS } from './verify.ts';

export { overall, formatReport, EXIT } from './report.ts';

export { httpRpc, describeEndpoint, EndpointError, RpcError } from './rpc.ts';
export type { HttpRpcOptions, Rpc } from './rpc.ts';

export { entryListJson, entryListCsv } from './entries.ts';
export type { EntryEnvelope, EntryRow } from './entries.ts';

export type { Purchase } from './commitment.ts';

export { checkKeccak256, KECCAK256_KNOWN_ANSWERS } from './keccak-selftest.ts';
export type { Keccak256 } from './keccak.ts';
