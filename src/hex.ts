// Conversions between chain values and bytes. Every chain value is a bigint;
// hex text is only ever an input or output format, never something compared.

const TWO_256 = 1n << 256n;
const TWO_160 = 1n << 160n;

export function hexToBytes(hex: string): Uint8Array {
  if (!/^0x([0-9a-fA-F]{2})*$/.test(hex)) {
    throw new Error(`not an even-length 0x-prefixed hex string: ${hex}`);
  }
  const out = new Uint8Array((hex.length - 2) / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(2 + 2 * i, 4 + 2 * i), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return '0x' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function bytesToBigint(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt(bytesToHex(bytes));
}

// Parses a 0x-prefixed value of exactly `bytes` bytes, as every word, hash
// and address arrives from RPC or a vector file.
export function parseFixedHex(hex: string, bytes: number): bigint {
  if (hex.length !== 2 + 2 * bytes) {
    throw new Error(`expected ${bytes}-byte hex, got ${hex}`);
  }
  return bytesToBigint(hexToBytes(hex));
}

export function parseDecimal(text: string): bigint {
  if (!/^(0|[1-9][0-9]*)$/.test(text)) throw new Error(`not a canonical decimal integer: ${text}`);
  return BigInt(text);
}

// One 32-byte big-endian word. A value that does not fit is a bug upstream of
// here, so it throws rather than truncating.
export function toWord(value: bigint): Uint8Array {
  if (value < 0n || value >= TWO_256) throw new Error(`value out of uint256 range: ${value}`);
  return hexToBytes('0x' + value.toString(16).padStart(64, '0'));
}

export function hex32(value: bigint): string {
  return bytesToHex(toWord(value));
}

export function hexAddress(value: bigint): string {
  if (value < 0n || value >= TWO_160) throw new Error(`value out of address range: ${value}`);
  return '0x' + value.toString(16).padStart(40, '0');
}
