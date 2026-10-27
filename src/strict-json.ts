// A strict JSON parser. JSON.parse cannot be used for descriptors: it accepts
// all four inputs PUBLIC-SPEC §9 says have no hash, and it erases the number
// token (`1.0` and `1` both become 1), so the no-float rule cannot even be
// checked on its output.
//
// Objects are Maps. A plain object would treat a "__proto__" key as a
// prototype assignment rather than data.

export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export type JsonObject = Map<string, JsonValue>;

export class JsonParseError extends Error {}

export interface ParseOptions {
  // Descriptor mode (PUBLIC-SPEC §9): reject any number token with a fraction
  // or exponent, whatever its value, and any integer of magnitude 2^53 or
  // more. Off, numbers parse as IEEE 754 doubles, as RFC 8785 requires of a
  // general JCS input.
  descriptorNumbers: boolean;
}

const MAX_DEPTH = 64;
const SAFE_LIMIT = 1n << 53n;
const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/y;

// UTF-8 without a byte-order mark, decoded strictly (PUBLIC-SPEC §9). A
// decoder that silently strips the mark or replaces malformed bytes would
// hash a text that a strict one rejects.
export function decodeUtf8Strict(bytes: Uint8Array): string {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new JsonParseError('text begins with a UTF-8 byte-order mark');
  }
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new JsonParseError('text is not well-formed UTF-8');
  }
}

export function parseJson(text: string, options: ParseOptions): JsonValue {
  let pos = 0;

  const fail = (message: string): never => {
    throw new JsonParseError(`${message} at offset ${pos}`);
  };

  const skipWhitespace = (): void => {
    while (pos < text.length && ' \t\n\r'.includes(text[pos] as string)) pos++;
  };

  const expect = (literal: string): void => {
    if (!text.startsWith(literal, pos)) fail(`expected ${literal}`);
    pos += literal.length;
  };

  const parseString = (): string => {
    expect('"');
    let out = '';
    for (;;) {
      if (pos >= text.length) fail('unterminated string');
      const ch = text[pos] as string;
      if (ch === '"') {
        pos++;
        break;
      }
      if (ch < ' ') fail('unescaped control character in string');
      if (ch !== '\\') {
        out += ch;
        pos++;
        continue;
      }
      const esc = text[pos + 1];
      const simple: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
      if (esc !== undefined && esc in simple) {
        out += simple[esc];
        pos += 2;
      } else if (esc === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(pos + 2, pos + 6))) {
        out += String.fromCharCode(Number.parseInt(text.slice(pos + 2, pos + 6), 16));
        pos += 6;
      } else {
        fail('invalid escape');
      }
    }
    // Escapes can spell a lone surrogate, which is not Unicode text. I-JSON
    // (RFC 7493), which RFC 8785 requires, forbids it.
    if (!out.isWellFormed()) fail('string is not well-formed Unicode (lone surrogate)');
    return out;
  };

  const parseNumber = (): number => {
    NUMBER.lastIndex = pos;
    const m = NUMBER.exec(text);
    if (m === null) return fail('invalid number');
    const token = m[0];
    if (options.descriptorNumbers) {
      if (m[1] !== undefined || m[2] !== undefined) fail(`number token ${token} has a fraction or exponent`);
      const magnitude = BigInt(token.startsWith('-') ? token.slice(1) : token);
      if (magnitude >= SAFE_LIMIT) fail(`integer token ${token} is outside the safe range (magnitude >= 2^53)`);
    }
    const value = Number(token);
    if (!Number.isFinite(value)) fail(`number token ${token} is not a finite double`);
    pos += token.length;
    return value;
  };

  const parseValue = (depth: number): JsonValue => {
    if (depth > MAX_DEPTH) fail('nesting too deep');
    skipWhitespace();
    const ch = text[pos];
    if (ch === '{') {
      pos++;
      const obj: JsonObject = new Map();
      skipWhitespace();
      if (text[pos] === '}') {
        pos++;
        return obj;
      }
      for (;;) {
        skipWhitespace();
        const key = parseString();
        // A duplicate key gives one text two readings; I-JSON forbids it.
        if (obj.has(key)) fail(`duplicate key ${JSON.stringify(key)}`);
        skipWhitespace();
        expect(':');
        obj.set(key, parseValue(depth + 1));
        skipWhitespace();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        expect('}');
        return obj;
      }
    }
    if (ch === '[') {
      pos++;
      const arr: JsonValue[] = [];
      skipWhitespace();
      if (text[pos] === ']') {
        pos++;
        return arr;
      }
      for (;;) {
        arr.push(parseValue(depth + 1));
        skipWhitespace();
        if (text[pos] === ',') {
          pos++;
          continue;
        }
        expect(']');
        return arr;
      }
    }
    if (ch === '"') return parseString();
    if (ch === 't') return expect('true'), true;
    if (ch === 'f') return expect('false'), false;
    if (ch === 'n') return expect('null'), null;
    return parseNumber();
  };

  const value = parseValue(0);
  skipWhitespace();
  if (pos !== text.length) fail('unexpected data after the JSON value');
  return value;
}
