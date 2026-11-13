import type { Purchase } from './commitment.ts';
import { hex32, hexAddress } from './hex.ts';
import { canonicalize } from './jcs.ts';
import type { JsonObject, JsonValue } from './strict-json.ts';

// The entry list file format (PUBLIC-SPEC §7). The file a verifier writes and
// the file the operator publishes must be byte-identical, so comparing them is
// a hash check rather than a field-by-field diff. Both forms are fixed by the
// spec and reproduced here from its prose, not from any serializer the operator
// runs. The serializers are the same ones the CLI and the web download use, so
// the two surfaces produce identical bytes from the same report.

// The scalar envelope that identifies the round a file belongs to (§7). Every
// value is reproduced verbatim from the deployment table (§10) and the round's
// EntryCommitted log (§4); nothing here is recomputed.
export interface EntryEnvelope {
  chainId: bigint;
  coreAddress: bigint;
  roundId: bigint;
  entryCommitment: bigint;
  totalTickets: bigint;
  commitBlock: bigint;
}

// One row carries exactly the six fields of §7. A Purchase already holds all
// six, so the ordered purchase list the verifier rebuilds is the row list.
export type EntryRow = Purchase;

// The row fields, in the order the CSV header fixes them (§7).
const CSV_HEADER = 'buyer,startIndex,endIndex,blockNumber,logIndex,transactionHash';

// Each row as its six string values, in the §7 order. Addresses are 42 chars,
// hashes 66, both lowercase; indices and block/log numbers are bare decimals.
// Every integer is a string so neither form depends on IEEE-754 formatting.
function rowFields(r: EntryRow): [string, string, string, string, string, string] {
  return [
    hexAddress(r.buyer),
    r.startIndex.toString(),
    r.endIndex.toString(),
    r.blockNumber.toString(),
    r.logIndex.toString(),
    hex32(r.transactionHash),
  ];
}

// The JSON form: RFC 8785 (JCS) canonical, by the same rules §9 publishes for
// the prize descriptor — keys sorted by code point, no insignificant
// whitespace, minimal escaping. The entries array keeps its §2 ordering
// (array order is semantic; JCS preserves it), while each object's keys are
// sorted by the canonicalizer. Because every value is a string, JCS number
// formatting is never exercised. The caller supplies `rows` already ordered.
export function entryListJson(env: EntryEnvelope, rows: readonly EntryRow[]): string {
  const entries: JsonValue[] = rows.map((r) => {
    const [buyer, startIndex, endIndex, blockNumber, logIndex, transactionHash] = rowFields(r);
    const o: JsonObject = new Map<string, JsonValue>([
      ['buyer', buyer],
      ['startIndex', startIndex],
      ['endIndex', endIndex],
      ['blockNumber', blockNumber],
      ['logIndex', logIndex],
      ['transactionHash', transactionHash],
    ]);
    return o;
  });
  const root: JsonObject = new Map<string, JsonValue>([
    ['chainId', env.chainId.toString()],
    ['coreAddress', hexAddress(env.coreAddress)],
    ['roundId', env.roundId.toString()],
    ['entryCommitment', hex32(env.entryCommitment)],
    ['totalTickets', env.totalTickets.toString()],
    ['commitBlock', env.commitBlock.toString()],
    ['entries', entries],
  ]);
  return canonicalize(root);
}

// The CSV form: the fixed header, then one line per row in §2 order, every line
// including the last ended by a single '\n' (U+000A), no other whitespace. No
// field can contain a comma, quote or newline, so no quoting rule is needed.
export function entryListCsv(rows: readonly EntryRow[]): string {
  let out = CSV_HEADER + '\n';
  for (const r of rows) out += rowFields(r).join(',') + '\n';
  return out;
}
