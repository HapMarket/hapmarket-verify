# hapmarket-verify

HapMarket runs prize draws on-chain. This tool lets you check any of those draws yourself, **without trusting HapMarket**. You choose the RPC endpoint. The tool reads only public chain data, recomputes the result from first principles, and prints every value it compared.

It doesn't talk to any HapMarket server, website, API or IPFS gateway. If every machine we run were switched off, this tool would still work.

## Run it

You need [Node.js](https://nodejs.org) 24 or later and git. There is nothing to install: the tool has no runtime dependencies.

```sh
git clone https://github.com/HapMarket/hapmarket-verify.git
cd hapmarket-verify
node src/cli.ts --rpc https://bsc-testnet-rpc.publicnode.com --round 1
```

That checks round 1 on the current BNB Chain testnet core. The output looks like this, shortened:

```
Round 1 on core 0x1d1da09ee37569fcf2351c3d0cfed43fc7d8db9d, chain 97
Read from bsc-testnet-rpc.publicnode.com at block 139462046

Round
  [PASS] Core's VRF coordinator is Chainlink's
      0xda3b641d438362c440ac5458c57e00a712b66700
  [PASS] Commitment: recomputed from purchases vs EntryCommitted
      0x7ca8e2661b5564000e98738a2835c56985a6e5dd146061363ccb3970d7910824
      2 purchase(s), folded from bytes32(0) in block/log order
  ...
Draw nonce 1 (original draw)
  [PASS] Seed equals keccak256(abi.encode(outputSeed, 0)) from the coordinator's log
  [PASS] Winning index: derived vs announced
      2
  [PASS] Owner of the announced index vs announced winner
      0x238bf05fc66286844ff2bc8414ab746877fa433a

Result: PASS. Every check passed: the round, as recorded on-chain, reproduces from chain data alone.
```

When values disagree, the tool prints both of them, not just "FAIL".

### Options

| Flag | Meaning |
|---|---|
| `--rpc <url>` | Any JSON-RPC endpoint for the chain. See [Choosing an endpoint](#choosing-an-endpoint). |
| `--round <id>` | The round to check. |
| `--core <address> --from-block <n>` | Check a round on another core contract, such as a superseded one. `--from-block` is the block the core was created in. |
| `--descriptor <file>` | Also check a prize description file against the hash the round committed to when it opened. |

The tool reads the chain ID from the endpoint. Without `--core`, it uses that chain's current core from [`PUBLIC-SPEC.md` §10](spec-public/PUBLIC-SPEC.md#10-deployments). That table is only a convenience: every check holds for whatever core you name, so you can check the address against a block explorer and pass it yourself.

### Exit status

| Code | Meaning |
|---|---|
| 0 | **Pass.** Every check agreed. |
| 1 | **Fail.** At least one check disagreed. The draw, as recorded on-chain, does not check out. |
| 2 | Usage or tool error. |
| 3 | **Incomplete.** The endpoint didn't supply all the data. Nothing was proven either way; try another endpoint. |
| 4 | **Pending.** The draw hasn't finished yet. Every step completed so far checks out. |
| 5 | **Unverifiable.** The prize description file is in a schema version newer than this tool. This is not a mismatch. |

### Choosing an endpoint

Any provider works, because none of them is us. **Many free endpoints keep only a day or two of logs.** Some of them answer a query about older blocks with an empty list instead of an error. A careless verifier would read that as "no entries".

This tool cross-checks the logs against the contract's current state, so a pruned endpoint shows up as **INCOMPLETE**, never as a pass or a fail. To check an older draw, use an endpoint that serves full log history, from any third-party provider or your own node.

## What a PASS proves

The protocol is specified in [`spec-public/PUBLIC-SPEC.md`](spec-public/PUBLIC-SPEC.md). For the round you name, across the original draw and every redraw, a PASS means all of the following were checked against chain data.

**The entries were fixed before the randomness existed.**
- The full entry list is rebuilt from the core's `TicketsPurchased` logs, in block and log order.
- The running commitment is recomputed from `bytes32(0)`, and it equals the commitment the contract stored and emitted.
- The ticket ranges tile `0 … totalTickets − 1` exactly.
- No purchase comes after the commitment.
- Every randomness request is in a strictly later block than the commitment.
- The commitment is identical for every redraw.

**The randomness came from Chainlink, and nobody chose it.**
- The core's `vrfCoordinator()` equals the coordinator **Chainlink publishes** for that chain. This repo keeps its own copy of that address, taken from Chainlink's documentation (see [below](#what-you-are-still-trusting)), never from anything we publish.
- The seed equals `keccak256(abi.encode(outputSeed, 0))`, where `outputSeed` comes from the `RandomWordsFulfilled` log **emitted by that coordinator** for the same request. That log is only emitted after the VRF proof was verified on-chain.
- No fulfilment failed.
- No draw had two fulfilments accepted, which would have let whoever ordered them pick the outcome.

**The winner follows from the seed.**
- The winning index is recomputed from the seed, round ID and draw nonce.
- On a redraw, the excluded tickets are derived from chain events alone, never from a list we publish.
- The index maps to the announced winner, and no excluded ticket won.

**Nobody vetoed a draw.**
- The round was not cancelled after randomness was requested.
- A refunded round needs a reason the chain shows: a refund must not void an outcome that was already readable.

**The logs agree with the contract's current state**, through `roundOf` and `drawOf`.

**With `--descriptor`, the prize is what the round committed to.** The file's canonical hash equals the hash recorded when the round opened.

## What it does not prove

Read this section before relying on a PASS.

- **It trusts the endpoint you choose to tell the truth about the chain.** It rejects logs that don't match its query, and it cross-checks logs against contract state. But an endpoint that fabricated a whole consistent chain could pass. If the stakes justify it, run the check against two unrelated providers, or your own node.
- **It trusts Chainlink VRF.** It confirms the seed came from Chainlink's coordinator, which verified the VRF proof. It doesn't re-verify the proof itself, and it can't rule out Chainlink colluding with someone.
- **It checks one round's records, not the contract's code.** It confirms this round's records follow the published protocol. It doesn't audit the contract source, and it doesn't check that the bytecode at the address matches any source.
- **It doesn't check timing rules the contract enforces.** That includes whether a claim window really expired before a redraw, and whether the refund deadlines were met. A redraw is checked for using the right excluded tickets, not for whether it should have happened.
- **Refund checks see only what reaches the chain.** A refund is flagged when Chainlink's fulfilment of the voided draw lands afterwards. That relies on Chainlink's node submitting the fulfilment, which it does for a request it is still serving.
- **It says nothing about payments, eligibility or prize delivery.** It checks who won, not what happened after.

## What you are still trusting

Everything the checks above rest on is in this repository, small enough to read:

- **Chainlink's coordinator addresses**, in [`src/chainlink.ts`](src/chainlink.ts). Each one is copied by hand from Chainlink's own documentation, with the URL and the date beside it. Compare them against [docs.chain.link](https://docs.chain.link/vrf/v2-5/supported-networks) yourself. This is the one table whose correctness the coordinator check depends on.
- **Event signatures**, in [`src/events.ts`](src/events.ts). They come from `PUBLIC-SPEC.md`, not from the contract's build output.
- **Keccak-256**, from Node's built-in `node:crypto` (OpenSSL), not a hand-written implementation. It is checked against known answers at startup.

## How it was built, and how to check the checker

**This verifier was written from the published protocol, not from the contract.** It doesn't import the contract package or the website's code, and it wasn't produced by translating Solidity. If both were built from one implementation, a bug in it would agree with itself and verification would catch nothing. The two implementations meet only at [`spec-public/vectors/`](spec-public/vectors): test vectors written before either implementation existed, which both must reproduce.

`spec-public/` is a checksummed copy of the public part of HapMarket's specification. It is never edited here.

The code is plain TypeScript with no framework and no runtime dependencies:

| File | What it does |
|---|---|
| `src/cli.ts` | Arguments and exit status |
| `src/verify.ts` | Every check, in protocol order |
| `src/rpc.ts`, `src/events.ts` | A minimal JSON-RPC client; log fetching, validation and ordering |
| `src/commitment.ts`, `src/seed.ts`, `src/derivation.ts` | The commitment, the seed and the winner derivation |
| `src/strict-json.ts`, `src/jcs.ts`, `src/schema.ts`, `src/descriptor.ts` | The prize description hash (RFC 8785 canonical JSON) |
| `src/report.ts` | The output you read |

To run the test suite, you need the two development dependencies, which are TypeScript and Node's type definitions:

```sh
npm ci
npm run typecheck
npm test
```

The tests include:
- **Conformance** against the published vectors and the RFC 8785 conformance suite.
- **Replays** of real testnet draws recorded from public endpoints ([`test/recorded/`](test/recorded)). These include a real draw that **fails**, because two of its randomness requests were both fulfilled.
- **Tampering tests:** for each way a draw could be falsified, one fact in a real recording is changed, and the check built for it must fail. These cover:
  - a changed buyer, a missing purchase, or a purchase after the commitment;
  - a forged seed or an impostor coordinator;
  - a wrong winner, or a cancel or refund that voids a known outcome.

## Licence

MIT. See [LICENSE](LICENSE).
