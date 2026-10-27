# Vector file format

**Published** (vendored into `hapmarket-verify`).

One envelope for every file in `vectors/`: `commitment.json`, `derivation.json`, `descriptor-hash.json`, `canonicalization.json`, and `seed.json`. Both implementations read these files unchanged; each implementation's conformance job is the same fixture read twice.

---

## Envelope

```json
{
  "vectorFormat": 1,
  "subject": "descriptor-hash",
  "status": "pendingTwoPersonPass",
  "cases": [
    { "name": "...", "description": "...", "input": {}, "expect": {} }
  ]
}
```

`subject` is one of `commitment`, `derivation`, `descriptor-hash`, `canonicalization`, `seed`.

`status` tracks the two-person process:

| Status | Meaning |
|---|---|
| `pendingTwoPersonPass` | Stub. Nobody has computed values. |
| `pendingSecondPass` | Person A has computed values. Person B has not checked them. |
| `complete` | Both passes done and reconciled. |

**CI fails on any file not marked `complete`**, and on any `complete` file with zero cases. Without this a stub — or a file holding only negative cases — passes a conformance job silently, which is the failure mode the vectors exist to prevent.

## Outcomes

Every case carries exactly one `expect.outcome`:

| Outcome | Used by | Shape |
|---|---|---|
| `commitment` | commitment | `value`: `0x`-prefixed 32-byte hex |
| `index` | derivation | `value`: decimal **string** |
| `hash` | descriptor-hash | `value`: `0x`-prefixed 32-byte hex |
| `reject` | any | `stage`: `parse` \| `schema` \| `normalization` \| `size` |
| `unverifiable` | descriptor-hash | `foundVersion`, `supportedVersions` |
| `revert` | derivation | `error`: the custom error name |
| `canonical` | canonicalization | `value`: the exact canonical JSON text, as a string |
| `seed` | seed | `value`: `0x`-prefixed 32-byte hex, the seed derived from `input.outputSeed` |

Several outcomes carry a **second assertion** alongside `value`. Each localises a failure that would otherwise be one opaque mismatch.

| Field | On | What it catches |
|---|---|---|
| `totalTickets` | `commitment` | An inclusive/half-open misreading, which changes the count independently of the hash |
| `attempts` | `index`, `revert` | An implementation that omits `i` from the derivation preimage — it matches the index only when `attempts` is 0 |
| `canonical` | `hash` | Whether a wrong hash came from canonicalization or from hashing |
| `preimage` | `seed` | Whether a wrong seed came from the 64-byte encoding or from hashing |

**`reject` and `unverifiable` are not the same result** and a harness must not collapse them. `reject` means the input is invalid. `unverifiable` means this tool is too old to judge it (`PUBLIC-SPEC.md` §9). Conflating them makes an honest draw look fraudulent.

**`stage` is part of the assertion, not documentation.** A case meant to fail at `schema` that fails at `normalization` is a passing test hiding a defect.

## Conventions

- **All 256-bit values and all indices are strings.** Foundry's JSON parsing and JavaScript's disagree about large integers. This governs the vector files themselves, and is separate from the descriptor's own no-float rule.
- Hex is `0x`-prefixed, lowercase, fixed width.
- Case `name` is unique within a file and stable — CI failures cite it.

---

## Two rules that exist because the obvious encoding breaks

### `parse`-stage cases use `inputRaw`, a string

A case asserting that the float token `1.0` is rejected **cannot** carry its input as parsed JSON. The harness parses the fixture with an ordinary JSON parser before the test runs, and in JavaScript `JSON.parse` collapses `1.0` and `1` to the same `number`. The distinction the case exists to test is destroyed before the code under test ever sees it.

So `parse`-stage cases carry `inputRaw`: a **string** holding the literal JSON text, handed to the loader unparsed.

```json
{
  "name": "floatToken",
  "inputRaw": "{\"schemaVersion\":1.0,\"name\":\"x\"}",
  "expect": { "outcome": "reject", "stage": "parse" }
}
```

Every other stage takes `input` as ordinary parsed JSON.

### Non-NFC strings are written as `\u` escapes, never as literal characters

A vector file containing a literal NFD string is fragile in a way that leaves no trace: an editor, a formatter, or a filesystem that normalizes on write turns it into NFC, the case silently starts testing nothing, and the diff looks empty because the two forms render identically.

Write both forms escaped, so the bytes are fixed by the file's ASCII content:

```
NFC  "Café"        U+00E9
NFD  "Café"       U+0065 U+0301
```

Emit these files with `ensure_ascii=True` or equivalent. The whole file should be ASCII.

---

## `canonicalization` is a separate subject, and why

Cases testing the **canonicalizer itself** do not belong in `descriptor-hash.json`, because their inputs are not descriptors and could never be.

`PUBLIC-SPEC.md` §9 requires a complete JCS implementation with a validating layer above it. So a float, or an integer at the safe-range boundary, is *invalid as a descriptor* and *perfectly valid as JCS input* — the validating layer rejects it, the canonicalizer must handle it correctly. A case like that asserts two contradictory things if filed under `descriptor-hash`.

`canonicalization.json` takes arbitrary JSON and asserts the canonical text JCS produces. It is where the published RFC 8785 conformance suite's concerns live, extended with the cases our own constraints make interesting.

---

## Informational input fields

A key prefixed with `_` inside `input` is an **annotation, not an input**. It records why a case was constructed the way it was, and an implementation must ignore it. `derivation.json` uses `_firstIterationIndex` to name the index the `i=0` hash produces, which is the whole point of the boundary cases — without it a reader cannot tell a case that exercises the exclusion loop from one that exits immediately.

Two consequences. A harness that rejects unknown input keys must skip `_`-prefixed ones. And a worksheet for the second person must **strip them**: they are computed values belonging to the first pass, and handing them over defeats the independence the pass is built on.

## Authoring

Negative cases — `reject`, `unverifiable`, `revert` — assert **where** an input fails. They carry no computed value, so they can be written directly from the spec prose.

Positive cases — `commitment`, `index`, `hash`, `canonical`, `seed` — carry a value that must be computed, and each value is produced by **two independent passes**: each works from the published prose alone, without seeing the other's method or any implementation, and the two are compared. A mismatch is treated as evidence that the prose is ambiguous. Any scratch script used is deleted, so it never becomes a third implementation. **Do not fill a positive case from an implementation.**

Each file's top-level `$comment` records who made each pass, with what tools, and any limit on how independent the passes were.
