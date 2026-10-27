# Canonical serialization of a prize descriptor

**Published** (vendored into `hapmarket-verify` alongside the schema).

Normative rules live in `PUBLIC-SPEC.md` §9. This file is the implementer's companion to `prize-descriptor.json`: what the schema does and does not catch, and why the shapes are what they are.

---

## The two documents do different jobs

`prize-descriptor.json` constrains the **input** — which fields may appear and what may go in them.

RFC 8785 (JCS) constrains the **output** — the exact bytes produced from a valid input.

A descriptor must pass both. Validation runs first; canonicalization never sees an invalid descriptor.

**This file and the schema are not themselves canonical JSON.** Only descriptors are canonicalized. The schema is an ordinary readable JSON document.

---

## Pipeline

```
descriptor JSON
   → parse                      (strict UTF-8, no byte-order mark; reject float-valued number tokens,
                                 integers ≥ 2⁵³, duplicate keys, lone surrogates — PUBLIC-SPEC.md §9)
   → version dispatch           (unknown version → UNVERIFIABLE, and stop)
   → schema validation          (prize-descriptor.json for that version)
   → NFC check                  (reject any non-NFC string, value or key, recursively; never normalize)
   → JCS canonicalization       (RFC 8785)
   → UTF-8 bytes                (reject if over 16384 bytes: the `size` stage)
   → keccak256                  → prizeDescriptorHash
```

**Version dispatch runs before schema validation, and the order is load-bearing.** `schemaVersion` is `const` in the schema, so a descriptor declaring version 2 would be *schema-rejected* by a version-1 validator. That is the one outcome `PUBLIC-SPEC.md` §9 forbids: a rejection is indistinguishable from a tampered descriptor, when the truth is only that the tool is too old. Dispatch first, and an unknown version reports `unverifiable` before any validation rule can fire.

Each rejection is a distinct outcome, named by its stage: `parse`, `schema`, `normalization`, `size`. A vector meant to fail at schema validation but failing at the NFC check instead is a passing test hiding a defect.

A `schemaVersion` that is not an integer is not a version, so dispatch does not report it unverifiable: it goes on to schema validation, which rejects it.

---

## What the schema enforces, and what it cannot

| Constraint (`PUBLIC-SPEC.md` §9) | Enforced by schema? |
|---|---|
| 1. ASCII keys | **Yes** — `propertyNames` at every level |
| 2. No floats | **Partly** — see below |
| 3. NFC normalization | **No** — loader check |
| 4. Explicit schema version | **Yes** — `required` + `const` |
| 5. No `null` | **Yes** — no `"type"` includes `"null"` |

### Constraint 2 is only partly enforceable, and this matters

JSON Schema's `"integer"` type matches **any number with a zero fractional part**. `1.0` is a valid `"integer"`. `"const": 1` likewise compares numerically, so `{"schemaVersion": 1.0}` passes validation.

Verified against the schema as written:

```
schemaVersion = 1.0  ->  ACCEPTED by JSON Schema validation
```

A correct JCS implementation then serializes it as `1`, because ECMAScript `Number::toString(1.0)` is `"1"` — so the hash still comes out right. But relying on that is exactly what constraint 2 exists to avoid: shortest-round-trip double formatting is the part of JCS implementations most likely to be wrong, and the contract-side pipeline and the reference verifier are written independently on either side of it.

**So the no-float rule needs a loader-level check**, in the same place as NFC:

```python
# reject float-valued tokens before validation
isinstance(value, int) and not isinstance(value, bool)
```

Python's `json` distinguishes `1` (int) from `1.0` (float) after parsing. In TypeScript, `JSON.parse` does not — both become `number` — so a TypeScript verifier must inspect the raw token, for example with a reviver or a scanning parse.

### Constraint 3 is a loader check

JCS does not normalize Unicode and does not warn. `"Café"` in NFC (U+00E9, 5 bytes UTF-8) and NFD (U+0065 U+0301, 6 bytes) are visually identical and hash differently. Verified: the schema accepts both.

Descriptors are normalized when they are authored. A verifier rejects a non-NFC descriptor at the `normalization` stage and never normalizes it first: hashing a normalized copy would attest to a text nobody published.

---

## Why the shapes are what they are

**`specification` is an object, not an array of `{key, value}` pairs.** JCS sorts object keys, so two authors listing the same attributes in different orders produce identical bytes. An array preserves order, which would give one prize two valid hashes.

**`images` *is* an array, and its order is part of the hash.** Display order is meaningful, so it is committed to deliberately. `uniqueItems` prevents the same image set having two forms.

**`schemaVersion` is `const`, not a free integer.** A descriptor declares the one version it was authored under. The hashing function branches on it (`PUBLIC-SPEC.md` §9 constraint 4), and a verifier that does not recognise a version reports *unverifiable*, never *mismatch*.

**`schemaVersion` denotes the field set, not the content.** Any change to which fields exist bumps it — adding, removing, renaming, retyping, **including adding an optional field**. Enum value additions do not, because the field set is unchanged: the value lives inside a field, not in the list of fields. So a version you recognise names exactly one field set, and the hashing branch is a lookup rather than a judgement.

**Nothing branches on an enum value.** Appending is free only because no code path depends on which value is present. If any behaviour ever keys off `category` or `condition`, appending becomes a new code path with its own tests, and the cheapness that justified append-only is gone. Behaviour that must vary belongs in the on-chain market configuration, where the chain enforces it.

**`images` carries opaque strings, with no filename pattern.** The descriptor must not encode a storage naming convention it does not control. A pattern would turn a cosmetic change in object-storage naming into a schema version bump, and a verifier never needs to parse a filename to reproduce a hash — it hashes the string as given.

**`prizeValueUsd` is absent by design.** The on-chain market configuration is authoritative for it (`PUBLIC-SPEC.md` §9). Two sources of truth for a number the chain controls is worse than one.

**Key ordering is never a judgement call.** Constraint 1 restricts keys to `^[a-z][a-zA-Z0-9]*$`, so JCS's UTF-16 key ordering and UTF-8 byte order cannot disagree. No implementation can sort wrongly, because the inputs that would distinguish the two orders cannot exist.

---

## Size cap: 16384 canonical bytes

Rejected at its own stage, `size`, after canonicalization (`PUBLIC-SPEC.md` §9).

**This cannot come from the schema.** JSON Schema's `maxLength` counts **characters, not bytes**, and a UTF-8 character takes up to four. The field limits bound a descriptor at 8.7 KiB of ASCII (8,931 canonical bytes with every field at its limit) but permit 29.5 KiB in astral-plane text (30,195 bytes; keys stay ASCII) — the character budget is spent while the byte budget is not bounded at all. A cap expressed in characters is not a cap on the published artefact.

16 KiB leaves 7.3 KiB of headroom over the ASCII worst case while bounding the non-ASCII one. The descriptor is published, mirrored to IPFS, and fetched by anyone verifying a draw, including on a phone.

---

## Content taxonomy

`category` and `condition` values are **schema vocabulary, not protocol vocabulary.** This schema is canonical for them. They carry no protocol meaning — nothing branches on them.

- **`category`: `electronics`, `fashion`, `homeAndLiving`.**
- **`condition`: `new`.**

Which values exist is a product decision; the protocol only requires that the set never shrinks and that nothing branches on it.

Values match `^[a-z][a-zA-Z0-9]*$`, enforced by `$defs/enumIdentifier` alongside the enum list. The redundancy is deliberate: a future append violating it fails at the first descriptor that uses it. ASCII also puts these values permanently out of reach of the NFC check, and makes them sort identically under UTF-16 and UTF-8.

**Enum values are identifiers, never display text.** The strings a user sees are kept outside the descriptor and are translatable. A value is never renamed to make it read nicely.
