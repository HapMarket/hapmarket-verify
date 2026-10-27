import { hexAddress } from './hex.ts';
import type { Check, RoundReport, Status } from './verify.ts';

// Human-readable output, for someone who did not write this tool. Every check
// prints with the values compared, passing ones included: a verdict without
// the evidence would ask the reader to trust the verifier, which is the thing
// this tool exists to avoid.

const MARK: Record<Status, string> = { pass: 'PASS', fail: 'FAIL', incomplete: 'INCOMPLETE', pending: 'PENDING', unverifiable: 'UNVERIFIABLE' };

// Exit statuses, distinct so a script can tell them apart.
export const EXIT = { pass: 0, fail: 1, usage: 2, incomplete: 3, pending: 4, unverifiable: 5 } as const;

export function overall(report: RoundReport): Status {
  const has = (s: Status): boolean => report.checks.some((c) => c.status === s);
  if (has('fail')) return 'fail';
  if (has('incomplete')) return 'incomplete';
  if (has('unverifiable')) return 'unverifiable';
  if (has('pending')) return 'pending';
  return 'pass';
}

export function formatReport(report: RoundReport, endpoint: string): string {
  const lines = [
    `Round ${report.roundId} on core ${hexAddress(report.core)}, chain ${report.chainId}`,
    `Read from ${endpoint} at block ${report.block}`,
    '',
  ];
  // Round-level checks first, then each nonce in order; within a group, the
  // order the checks ran in.
  const grouped = [...report.checks].sort((a, b) =>
    a.nonce === b.nonce ? 0 : a.nonce === undefined ? -1 : b.nonce === undefined ? 1 : a.nonce < b.nonce ? -1 : 1,
  );
  let section: bigint | undefined | null = null;
  for (const c of grouped) {
    if (c.nonce !== section) {
      section = c.nonce;
      lines.push(section === undefined ? 'Round' : `Draw nonce ${section}${section === 1n ? ' (original draw)' : ' (redraw)'}`);
    }
    lines.push(...formatCheck(c));
  }
  const verdict = overall(report);
  lines.push('', `Result: ${MARK[verdict]}. ${VERDICT[verdict]}`);
  return lines.join('\n');
}

function formatCheck(c: Check): string[] {
  const out = [`  [${MARK[c.status]}] ${c.title}`];
  if (c.expected !== undefined && c.actual !== undefined && c.expected === c.actual) {
    out.push(`      ${c.actual}`);
  } else {
    if (c.expected !== undefined) out.push(`      expected: ${c.expected}`);
    if (c.actual !== undefined) out.push(`      actual:   ${c.actual}`);
  }
  if (c.note !== undefined) out.push(`      ${c.note}`);
  return out;
}

const VERDICT: Record<Status, string> = {
  pass: 'Every check passed: the draw reproduces from chain data alone.',
  fail: 'At least one check failed: the draw as recorded on-chain does not reproduce. See the FAIL lines above.',
  incomplete: 'The endpoint did not supply all the data needed, so nothing was proven either way. Retry with an endpoint that serves full log history.',
  pending: 'Every completed step checks out; the draw has not finished yet.',
  unverifiable: 'The prize descriptor is newer than this verifier. This is not a mismatch; use a newer version of the verifier.',
};
