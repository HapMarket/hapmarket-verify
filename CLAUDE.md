# CLAUDE.md — lottery-verify

@spec-public/PUBLIC-SPEC.md

**This repo is public.** It is the only public repo in the project.

---

## What this is

A standalone CLI that takes a round ID and a public RPC endpoint and independently reproduces a draw result. It is the thing that makes the product's central claim true rather than marketing.

It is public from day one, before the contracts are deployed, because a verifier nobody can read verifies nothing.

---

## Why there is no `spec/` submodule here

The shared specification repo is private. A public repo cannot use a private submodule — outsiders could not clone it, and the entire point of this repo is that outsiders can.

Instead this repo carries a committed copy of the public subset:

```
spec-public/
  PUBLIC-SPEC.md               the verification protocol
  schema/prize-descriptor.json
  schema/CANONICAL.md          descriptor pipeline companion
  vectors/FORMAT.md            vector envelope and outcomes
  vectors/*.json
  CHECKSUMS
```

CI has read access to the private source and **fails if the checksums do not match**. Syncing is a deliberate commit, never an automated push, so a change upstream cannot silently alter a published artefact.

Everything a verifier needs is here. Nothing private is.

**Do not add private material to this repo.** No margin figures, no key structure, no treasury layout, no internal decisions. If something seems needed from `CORE.md`, that is a signal the protocol document is incomplete — fix it upstream rather than pasting here.

---

## The independence rule

**This implementation is written from `PUBLIC-SPEC.md`, not from the contract source, and not from the frontend's code.**

It must not import `@lottery/contracts`, must not import anything from `lottery-web`, and must not be produced by transliterating Solidity.

If one implementation were shared, a bug in it would be invisible to verification, because both sides agree while both are wrong. Two independent implementations checked against vectors written before either of them catch exactly that.

The only shared artefact is `spec-public/vectors/`, and those are the arbiter, not a source.

ABIs and addresses are checked into this repo by hand rather than pulled from the contracts package. Yes, that is duplication. It is deliberate.

---

## Hard requirements

1. **Runs from a public RPC endpoint alone.** No API of ours, no IPFS gateway of ours, no environment variable pointing at our infrastructure. The Phase 2 gate is reproducing a testnet draw with everything we run switched off.
2. **Reconstructs the entry list from chain events.** It may accept a downloaded entry file as an optional cross-check, but it must be able to rebuild the list itself from `TicketsPurchased` events in block and log order.
3. **Minimal dependencies.** Every dependency is attack surface and a reason to distrust the output. A reviewer should be able to read the whole thing in an afternoon. CI enforces a dependency count ceiling.
4. **Deterministic.** Given the same chain data, the same result, every time.
5. **One documented command on a clean machine.** If reproducing a draw takes setup, nobody will do it, and the guarantee is theoretical.

---

## What it verifies

For a round, across **every draw nonce**, not only the final one:

- Rebuild the ordered entry list from events, by block number then log index
- Recompute the running commitment from `bytes32(0)` and compare to the on-chain value
- Confirm the commitment block strictly precedes the VRF request block
- Confirm the commitment is byte-identical across every nonce
- Confirm the seed came from Chainlink: the core's `vrfCoordinator()` equals Chainlink's published coordinator for the chain, and the seed equals `keccak256(abi.encode(outputSeed, 0))` for the `RandomWordsFulfilled` log **emitted by that address** for the same `requestId` (`PUBLIC-SPEC.md` §8 steps 6–7)
- Recompute the winning index from seed, round ID, nonce, and excluded set
- Confirm the derived index maps to the announced winner address
- Confirm no excluded index was returned

**Chainlink's coordinator addresses are a table this repo owns**, copied by hand from Chainlink's documentation with the source URL and date beside each entry. Never read them from `@lottery/contracts`, from `lottery-web`'s `ChainConfig`, or from anything the operator publishes. The operator's copy of that address is precisely the value the check exists to test, so taking it from the operator turns the check into a tautology.

Exit non-zero on any mismatch, with output saying which check failed and what the two values were. A verifier that fails silently or vaguely is worse than none.

---

## Layout

```
CLAUDE.md
README.md            written for an outside skeptic, not for us
LICENSE
spec-public/         vendored, checksum-verified
src/
  rpc.ts             minimal JSON-RPC client, no SDK
  events.ts          log fetching and ordering
  commitment.ts      independent running-hash implementation
  derivation.ts      independent index derivation
  seed.ts            outputSeed → seed (PUBLIC-SPEC §4)
  abi.ts, hex.ts     32-byte word encoding, bigint ↔ bytes
  keccak.ts          the Keccak256 type; node-keccak.ts binds node:crypto
  strict-json.ts     strict parser (PUBLIC-SPEC §9 parse stage)
  jcs.ts             complete RFC 8785 canonicalizer
  schema.ts          validator for the keywords the vendored schema uses
  descriptor.ts      the descriptor pipeline, stage by stage
  report.ts          human-readable output
test/
  vectors.test.ts    conformance against spec-public/vectors
  rfc8785/           RFC 8785 conformance suite, vendored unchanged
  recorded/          recorded testnet draws, replayed in CI
abi/                 hand-maintained, not generated
```

---

## Conventions

- TypeScript, `strict: true`, no `any`.
- `bigint` for every chain value. Never `number` for anything that came off the chain.
- No logging framework, no config framework, no DI. Plain functions.
- Output readable by someone who did not write it. Show the values being compared, not just pass or fail.
- Comments explain *why a check exists* and which guarantee it enforces. A reviewer of this repo is auditing the guarantee, not the code style.
- `README.md` is addressed to a skeptical outsider: what this proves, what it does not, and how to run it against a draw they choose.

---

## Publishing

This repo publishes a small package that `lottery-web` imports for the verify page. That is the one permitted downstream consumer.

The independence that matters is between the contract and the verifier. Between the verifier and the page displaying its results, sharing is correct — a third implementation would add risk without adding a check.

---

## Do not

- Import the contracts package, the frontend, or any of our services
- Add private material from `CORE.md` to this repo
- Edit `spec-public/` by hand. It is synced from the private source and checksum-verified.
- Add a convenience dependency to save a few lines
- Adjust a vector to make a test pass
- Add caching that could serve a stale result
- Make any output depend on data we host
