# Verification protocol

This document specifies exactly how a draw is produced and how anyone can independently reproduce the result. It is published so that verification does not require trusting the operator, the website, or any service the operator runs.

Everything needed to check a draw is here or on-chain. No part of this depends on infrastructure the operator controls.

---

## 1. Terms

| Term | Meaning |
|---|---|
| **Market** | A prize and its draw configuration. |
| **Round** | One instance of a market running to a draw. |
| **Ticket** | One entry. Indivisible. |
| **Entry** | A ticket owned by a specific address in a specific round. |
| **Entry commitment** | An on-chain running hash binding the exact entry set at round close. |
| **Seed** | The random value delivered to the contract for a draw: `uint256(keccak256(abi.encode(outputSeed, 0)))`, where `outputSeed` is the verified VRF output the VRF coordinator logs (§4). Not the VRF output itself. |
| **VRF coordinator** | Chainlink's contract that verifies a VRF proof on-chain and delivers the resulting randomness. Chainlink publishes one address per chain; the core contract fixes it at deployment and can never change it. |
| **Draw nonce** | Incrementing counter distinguishing the original draw from each redraw. |
| **Excluded set** | Ticket ranges removed from eligibility on a redraw. |

---

## 2. Entries and ordering

Entries are stored as **purchase ranges**, not one record per ticket. A purchase of 50 tickets is one record with a start and end index.

**Indices are zero-based, and ranges are inclusive on both ends.** The first ticket in a round is index 0. A range covers `[startIndex, endIndex]`:

| Purchase | Range | Tickets |
|---|---|---|
| First 50 tickets of a round | `(0, 49)` | 50 |
| A single ticket at index 5 | `(5, 5)` | 1 |
| Next 10 after `(0, 49)` | `(50, 59)` | 10 |

`ticketCount = endIndex - startIndex + 1`, and `endIndex >= startIndex` always. Both values are hashed directly into the commitment, so reading them as half-open produces a different commitment for every round.

**Ordering is by purchase index, ascending.** The contract assigns each index, so ties are impossible. Reconstructing the entry list from chain events requires ordering events by block number, then by log index within the block. Any other ordering produces a different commitment.

### The purchase event

Every purchase emits:

```solidity
event TicketsPurchased(
    uint256 indexed roundId,
    address indexed buyer,
    uint256 startIndex,
    uint256 endIndex,
    address stablecoin,
    uint256 stableAmount,
    uint256 creditAmount,
    address indexed referrer
);
```

Signature `TicketsPurchased(uint256,address,uint256,uint256,address,uint256,uint256,address)`; `roundId`, `buyer` and `referrer` are indexed topics.

**Verification reads four fields:** `roundId` and `buyer` from the topics, `startIndex` and `endIndex` from the data. They are exactly the values folded into the commitment (§3). The remaining fields record how the purchase was paid and who referred the buyer; they never affect the commitment or the draw, and a verifier may ignore them.

Fetch these logs filtered by the core contract's address as well as the signature — any contract can emit an event with the same signature.

---

## 3. The entry commitment

The commitment is a running hash maintained **by the contract itself**, updated on every purchase:

```solidity
entryCommitment = keccak256(
    abi.encode(entryCommitment, buyer, startIndex, endIndex)
);
```

The initial value is `bytes32(0)`.

**Every value is encoded as a full 32-byte word.** The `abi.encode` call takes `(bytes32, address, uint256, uint256)` — the running commitment, the buyer, `startIndex`, `endIndex`. The two indices are `uint256`, left-padded to 32 bytes, not a narrower integer type. Encoding them at any other width produces a different commitment for every non-empty round.

A round with no purchases commits to `bytes32(0)`: the hash is never invoked, so the initial value stands.

This design is deliberate. A merkle root over the entry list cannot be computed on-chain at reasonable cost, so it would have to be submitted by the operator — and whoever supplies the commitment controls what the draw is verified against. A running hash costs O(1) per purchase, takes no operator input at any point, and is reproducible by anyone replaying `TicketsPurchased` events.

**The commitment is written once and never recomputed**, including across redraws. A verifier should confirm the value is byte-identical at every draw nonce for a round.

A merkle tree may be published separately for convenient inclusion proofs. It is a convenience and is never the commitment.

---

## 4. The four-step protocol

1. **Freeze.** The round closes and accepts no further entries. The contract emits:
   `EntryCommitted(roundId, entryCommitment, totalTickets, commitBlock)`

2. **Request.** The contract requests randomness from the Chainlink VRF v2.5 coordinator and emits:
   `RandomnessRequested(roundId, drawNonce, requestId)`

   This **must occur in a strictly later block than the commitment**. The contract enforces `block.number > commitBlock`.

3. **Fulfil.** The coordinator returns the seed. The contract stores it, sets a one-way flag, and emits:
   `RandomnessFulfilled(roundId, drawNonce, requestId, seed)`

   `requestId` identifies which request produced the seed. A draw nonce can carry more than one request when a request times out and is retried, and whichever is fulfilled first supplies the seed; a fulfilment arriving for a nonce that already holds a seed changes nothing.

4. **Derive.** A separate, permissionless call computes the winning index and emits:
   `WinnerSelected(roundId, drawNonce, winningIndex, winner)`

The ordering constraint in step 2 is the core guarantee. Because the commitment is emitted in an earlier block than the randomness request, the entry set provably could not have been altered after the seed was known.

### Event signatures

A verifier finds these logs by their topic, which is the keccak256 of the signature, so the types and indexed flags are part of the protocol. They are stated here so that a verifier never has to read the contract source to find them.

```solidity
event TicketsPurchased(uint256 indexed roundId, address indexed buyer, uint256 startIndex, uint256 endIndex, address stablecoin, uint256 stableAmount, uint256 creditAmount, address indexed referrer);
event EntryCommitted(uint256 indexed roundId, bytes32 entryCommitment, uint256 totalTickets, uint256 commitBlock);
event RandomnessRequested(uint256 indexed roundId, uint256 drawNonce, uint256 indexed requestId);
event RandomnessFulfilled(uint256 indexed roundId, uint256 drawNonce, uint256 indexed requestId, bytes32 seed);
event WinnerSelected(uint256 indexed roundId, uint256 drawNonce, uint256 winningIndex, address indexed winner);
event DrawForfeited(uint256 indexed roundId, uint256 drawNonce, address indexed winner);
event RoundCancelled(uint256 indexed roundId);
```

`drawNonce` is **not** indexed. Filter these logs by `roundId`, then read the nonce from the data.

The core contract also exposes `function vrfCoordinator() external view returns (address)`.

`seed` is a `bytes32`, as in `deriveIndex` (§5). Section 4's delivered value `uint256(keccak256(…))` is the same 32-byte word read as a number, so converting between the two changes no bits.

`commitBlock` is the number of the block the `EntryCommitted` log was emitted in. A verifier checks the field against the log's block, because the ordering guarantee in step 2 is enforced against this field.

**The original draw is `drawNonce` 1.** Each redraw increments the nonce by one, and the contract allows at most two redraws (`MAX_REDRAWS() = 2`). A round therefore has at most three nonces: 1, 2 and 3. If a verifier finds a nonce above 1 with no lower nonce present, its history is incomplete. It must fail, not treat the lowest nonce it found as the original draw.

`DrawForfeited` is emitted when a redraw begins and names the forfeiting winner of the earlier nonce. It is a cross-check only. The excluded set is still derived from `WinnerSelected` (§8).

**A round with no purchases is never drawn.** Freezing an empty round reverts, so every committed round has at least one purchase. The `bytes32(0)` case in §3 describes the commitment's initial value, not a round that reaches a draw.

### Where the seed comes from

**The randomness source is fixed at deployment.** The core contract stores the VRF coordinator's address as an immutable set in its constructor, exposes it as `vrfCoordinator()`, and accepts a fulfilment from that address only. No function can change it. A consumer whose coordinator can be changed after deployment would let whoever holds that power substitute a contract of their own that delivers a chosen seed — Chainlink's standard `VRFConsumerBaseV2Plus` is such a consumer, since its owner may call `setCoordinator` at any time, and the core does not use it.

**Every seed traces to a verified VRF proof.** The contract requests exactly one random word per request. When the coordinator fulfils it, the coordinator verifies the VRF proof on-chain and, in the same transaction, emits from its own address:

`RandomWordsFulfilled(requestId, outputSeed, subId, payment, nativePayment, success, onlyPremium)`

This event belongs to Chainlink's `VRFCoordinatorV2_5`, not to the operator, and its signature is Chainlink's:

```solidity
event RandomWordsFulfilled(uint256 indexed requestId, uint256 outputSeed, uint256 indexed subId, uint96 payment, bool nativePayment, bool success, bool onlyPremium);
```

This signature matches the logs Chainlink's BNB Chain testnet coordinator emits: three topics (the signature, `requestId`, `subId`) and five data words.

The matching log must carry `success = true`. When `success` is false the consumer's callback reverted, so no seed was stored from that fulfilment.

**A `success = false` fulfilment of any of the round's requests fails the draw**, even if a later request produced a seed that reproduces. The failed fulfilment still published its `outputSeed`, and with it the outcome, while leaving the nonce open to retry — so the seed that was finally used was drawn after a first outcome was already known. The core's callback is built never to revert for a request it made, so this should never occur; a verifier reports it as a distinct failure rather than passing the draw.

The value it delivers is `uint256(keccak256(abi.encode(outputSeed, 0)))` — both arguments `uint256`, so the preimage is exactly 64 bytes — and that value is the seed. The seed in `RandomnessFulfilled` must therefore equal that hash of the `outputSeed` the coordinator logged for the same `requestId`.

Neither check can be skipped. A fixed coordinator is worthless if nobody confirms it is Chainlink's; a matching log is worthless if it could have been emitted by any contract.

### No re-rolls

**Randomness cannot be re-rolled.** Once a seed has been fulfilled for a draw nonce, retry is permanently impossible, enforced by a one-way flag set in the VRF callback before any other logic runs. If no seed was ever fulfilled — for example the VRF subscription ran out — anyone may retry the request against the same unchanged commitment.

---

## 5. Winner derivation

```solidity
function deriveIndex(
    bytes32 seed,
    uint256 roundId,
    uint256 drawNonce,
    uint256 totalTickets
) pure returns (uint256) {
    for (uint256 i = 0; i < MAX_ATTEMPTS; i++) {
        uint256 idx = uint256(
            keccak256(abi.encode(seed, roundId, drawNonce, i))
        ) % totalTickets;
        if (!isExcluded(idx)) return idx;
    }
    revert NoEligibleIndex();
}
```

**`MAX_ATTEMPTS` is 256.** Exhausting it reverts with `NoEligibleIndex`, and the round then becomes permissionlessly refundable rather than stranding. With an excluded fraction `f` the probability of exhaustion is `f²⁵⁶` — negligible below roughly 95% exclusion.

`roundId` is mixed in so one VRF fulfilment can never be reused across rounds. `drawNonce` distinguishes redraws.

On an original draw the excluded set is empty and the loop exits on the first iteration. On a redraw it steps past forfeited ranges. The excluded set only ever contains ranges belonging to winners who forfeited, so iteration is bounded.

Modulo bias on a 256-bit uniform input against a ticket count in the thousands is approximately 2⁻²⁴⁰. Rejection sampling is not used; the simpler function is easier to verify.

The resulting index maps into the ordered entry list via binary search over purchase ranges.

---

## 6. Redraws

If a winner does not claim within the claim window, **every purchase range belonging to that address** is added to the round's **excluded set**, the draw nonce increments, and a fresh randomness request is made against **the original, unchanged commitment**.

All of the forfeiting address's ranges are excluded, not only the range containing the winning index. When you reproduce a redraw, expect the excluded set to cover every range that address holds.

**Excluded ranges are inclusive on both ends, like entry ranges in §2.** `isExcluded(idx)` is true when `startIndex <= idx <= endIndex` for any range in the set, so a range removes `endIndex - startIndex + 1` tickets from eligibility.

The entry set is never edited and the commitment is never recomputed. This is stronger than filtering the entry list, because a verifier can confirm the same commitment across every nonce, and the excluded set is public.

A maximum of two redraws occur.

---

## 7. Published data

For every draw, including every redraw:

- The ordered entry list, as JSON and CSV, mirrored to IPFS
- The commitment and the transaction that emitted it
- The draw nonce
- The excluded set, if any
- The VRF request ID and the fulfilment transaction
- The VRF coordinator address the core contract was deployed with
- The raw seed
- The derivation function, as specified above
- The winning index and winner address

**The entry list is fully reconstructible from chain events alone.** Published files and IPFS mirrors are a convenience. If every server the operator runs disappeared, every historical draw would remain independently verifiable from any RPC endpoint that serves the chain's full log history.

**Not every public endpoint does.** Many free endpoints keep logs for only a day or two, refuse `eth_getLogs` over older ranges, or return an **empty list, with no error,** for blocks they have pruned. To a careless verifier, that empty answer looks exactly like a round with no entries. Use an endpoint that serves full history; any third-party provider will do, since none of them is the operator. A verifier must also detect a pruned endpoint rather than trust it (§8, "Logs agree with current state").

---

## 8. How to verify a draw yourself

Against an RPC endpoint that serves full log history (§7), for a given round and every draw nonce:

1. Fetch all `TicketsPurchased` events (§2) emitted by the core contract for the round. Order by block number, then log index.
2. Recompute the running hash from `bytes32(0)` using the formula in §3.
3. Compare it to the on-chain commitment. They must match exactly.
4. Confirm the commitment block is strictly earlier than the randomness request block.
5. Confirm the commitment is byte-identical across every draw nonce for this round.
6. Read the core contract's `vrfCoordinator()` and confirm it equals the VRF v2.5 coordinator address **Chainlink publishes** for this chain. Take that address from Chainlink's own documentation, never from anything the operator publishes — the operator's copy is exactly the value being checked.
7. Read `requestId` and the seed from `RandomnessFulfilled`. Find the `RandomWordsFulfilled` log for that `requestId` **emitted by the coordinator address from step 6** — filter by emitting address, because any contract can emit an event with the same signature. Confirm `uint256(keccak256(abi.encode(outputSeed, 0)))` equals the seed.
8. Derive the excluded set for this nonce from chain events alone (below), then recompute the index using the function in §5.
9. Confirm the index maps to the announced winner address, and that no excluded index was returned.

Each of these structural checks catches a defect the steps above would miss:

- **The ranges tile the round.** In purchase order, the first range starts at 0, each range starts one past the end of the previous one, and the last ends at `totalTickets - 1`. A gap or overlap means the event list is incomplete or the contract assigned indices wrongly. Either way the binary search in step 9 is no longer well-defined.
- **`commitBlock` matches its log.** The `commitBlock` field in `EntryCommitted` equals the block the log was emitted in (§4).
- **Every request is after the commitment.** This includes retried requests, not only the one that was fulfilled.
- **No fulfilment failed.** For every `requestId` in the round's `RandomnessRequested` logs, the coordinator's `RandomWordsFulfilled` log, if one exists, carries `success = true` (§4).
- **Nonces are complete.** They run 1, 2, … with no gap and no more than three (§4, §6).
- **Logs agree with current state.** At the latest block, `roundOf(roundId)` reports the same commitment, total tickets, commit block and current nonce as the logs. `drawOf(roundId, n)` reports the same request, seed, winner and winning index for every nonce `n` with a `WinnerSelected` log. An endpoint that has pruned old logs fails this check. A missing log is reported as an incomplete endpoint, never as a different result. State at the latest block is served even by endpoints that prune history, so this check needs nothing more than the logs do.
- **No cancellation after randomness was requested.** A round with a `RoundCancelled` log after any `RandomnessRequested` log fails. The seed becomes public when it is fulfilled, and the VRF proof is visible in the mempool before that, so cancelling after a request would let the operator veto a draw it had seen. The core refuses such a cancel; the verifier checks rather than trusts it.
- **The commitment is unique and final.** `EntryCommitted` is emitted exactly once for the round. Every `TicketsPurchased` log for the round comes before it in chain order (block number, then log index).

### Deriving the excluded set without trusting anyone

Step 8 needs the excluded set, and a published file stating it would put the operator back in the trust path for every redraw. It is not needed: **the excluded set is computable from `WinnerSelected` events and the entry list.**

For draw nonce `n`, the excluded set is every purchase range belonging to the winner of every earlier nonce:

```
excluded(n) = union over k < n of ranges(WinnerSelected(roundId, k).winner)
```

For the original draw, `n` is the first nonce and the set is empty.

This works because a **new draw nonce can only mean a forfeit.** A VRF retry re-requests randomness against the same nonce (§4), and retry is impossible once a seed has been fulfilled for that nonce — so a nonce that advanced is a claim window that expired, and §6 excludes every range of that address. The published excluded set is a convenience; this derivation is the authority, and the two must agree.

A reference implementation is published at `hapmarket-verify`. It is written independently of the contract, reads only from an RPC endpoint you choose, and depends on no operator infrastructure. Its results can be reproduced on a clean machine with a single command.

Test vectors for the commitment, the derivation function, the seed, the canonicalizer, and the canonical prize descriptor hash are published alongside it. Both the contract and the reference implementation are checked against those vectors, which were written before either implementation existed.

---

## 9. Prize descriptor hash

Each market commits on-chain to a hash of its canonical prize metadata, so the prize description cannot be altered after the fact.

The serialization follows **RFC 8785, JSON Canonicalization Scheme**, with five additional constraints that a verifier can rely on:

1. **Keys are ASCII only**, matching `^[a-z][a-zA-Z0-9]*$`. RFC 8785 sorts keys by UTF-16 code unit, which differs from UTF-8 byte order above U+FFFF; restricting keys to ASCII means the two orders can never disagree.
2. **No floating-point numbers.** Every numeric field is an integer below 2⁵³, or a string. Values outside safe integer range are carried as strings, per RFC 8785's own recommendation. This removes any dependence on shortest-round-trip double formatting.
3. **All string values are NFC-normalized.** JCS does not normalize Unicode, so this is enforced at authoring time and checked in CI, and a verifier rejects a descriptor holding any string that NFC would change. It never normalizes the string and hashes the result: that would give a descriptor the hash of a different text.
4. **An explicit schema version** is part of the descriptor. Descriptors keep the version they were authored under, so every historical hash continues to reproduce if the schema later changes.
5. **No `null`.** An optional field is either present with a value or absent; `null` is rejected before hashing. RFC 8785 canonicalizes `null` without complaint, and `{"a":null}` and `{}` hash differently, so allowing both would give one descriptor two valid hashes.

The hash is `keccak256` over the canonical UTF-8 bytes.

**The text is UTF-8 without a byte-order mark.** Decode it strictly: malformed UTF-8, or a byte-order mark at the start, is rejected at the parse stage. A decoder that silently strips the mark would accept a text that a strict one rejects.

**Parse descriptor text strictly.** Reject, before anything else: a number token with a fraction or an exponent (`1.0`, `1e0`), whatever its value; an integer token of magnitude 2⁵³ or more; a duplicate key in any object; and a string or key that is not well-formed Unicode, such as a lone surrogate written as an escape. RFC 8785 requires I-JSON input (RFC 7493), which forbids the last two. A default JSON parser accepts all four, and a verifier built on one would hash texts that have no hash.

**A `schemaVersion` that is not an integer is invalid, not unknown**: it is rejected by schema validation. Only an integer version your tool does not recognise is unverifiable.

**The size cap is 16384 bytes of canonical UTF-8**, checked after canonicalization: a descriptor over it is rejected and never hashed.

**The stages run in this order**, and a descriptor is reported at the first one that refuses it:

1. **parse**: decode the UTF-8 text and parse it strictly, as above;
2. **version dispatch**: an integer `schemaVersion` your tool does not recognise stops here as *unverifiable*, so a newer descriptor is never rejected by an older schema;
3. **schema**: validate against `schema/prize-descriptor.json` for that version;
4. **normalization**: reject any string, value or key, that is not NFC;
5. **canonicalize**, then **size**: reject a canonical form over 16384 bytes;
6. **hash**: keccak256 over the canonical UTF-8 bytes.

**The field set for each `schemaVersion` is defined by `schema/prize-descriptor.json`, published alongside this document.** Validation against that schema is part of reproducing the hash, and the order is fixed: validate, then canonicalize, then hash. A descriptor that fails validation has no hash at all — it is rejected, never hashed and compared.

**Implement the canonicalizer as a complete RFC 8785 implementation, with the five constraints above enforced in a validating layer on top of it.** The constraints narrow what a *descriptor* may contain; they do not narrow what JCS is. A canonicalizer that cannot represent a float or a `null` cannot run most of the published RFC 8785 conformance suite — and that suite is the only external check on this part of the pipeline.

### Enum values only ever widen

Values in descriptor enums such as `category` and `condition` are **append-only**: never renamed, never removed.

This is a guarantee you can rely on when checking an old draw. Validation is part of reproducing a descriptor hash, so a descriptor that validated when it was authored will still validate against a later schema of the same version. Adding a value cannot invalidate an existing descriptor; that is why adding one does not change the schema version.

The schema version denotes the **field set**. Any change to which fields exist — including adding an optional one — bumps it. Adding an enum value does not, because the field set is unchanged. So a `schemaVersion` you recognise always names exactly one set of fields, and nothing in the protocol branches on an enum value.

### Unknown schema versions

If you are verifying a descriptor whose `schemaVersion` your tool does not recognise, the tool **must report the descriptor as unverifiable and must not report a mismatch.** These are different results: a mismatch means the descriptor does not match what the chain committed to, while an unknown version means your tool is older than the descriptor. A tool that returns the first when it means the second makes an honest draw look fraudulent.

Expect a distinct exit status and a message naming the version found and the versions supported. Descriptors authored under a version your tool does know continue to verify indefinitely — that is the reason the version is recorded in the descriptor at all.

`prizeValueUsd` is deliberately **not** part of the descriptor. It lives in the on-chain market configuration, where the chain is authoritative. The descriptor covers only what the chain cannot express: name, specification, condition, images, and category.

The schema, the JCS conformance tests, and the descriptor-hash vectors are published with the reference implementation.

Translations are not part of the hashed descriptor. The canonical descriptor is English.

---

## 10. Deployments

A verifier needs to know which contract to read and which block to start scanning logs from. These facts are published here, and each can be checked against something the operator does not control: the block explorer's record of the creation transaction, and the bytecode at the address.

| Chain | Chain ID | Core contract | Created in block | Creation transaction |
|---|---|---|---|---|
| BNB Chain testnet | 97 | `0xa0ca23bfb669acad267a1acaf142cd4b3415e759` | 139115294 | `0xf8254177dd5c0e143087c8e6947bc0c9905746d5faf72566bfdc36fb39f50217` |
| BNB Chain mainnet | 56 | not yet deployed | | |

Scanning logs from the creation block onward is complete, because no event can come before the contract exists.

A chain can list more than one core: when a new core is deployed, rounds already open stay on the old one and settle there. A round is read from the core that opened it, from that core's creation block, and only the first row for a chain opens new rounds. On mainnet a superseded core stays listed for good, so every draw it held remains checkable. Testnet cores carry no user funds, and a superseded one is dropped.

**A round is identified by its core and its round ID together.** Round IDs restart at 1 on every core. Nor does the commitment identify a round: it binds only the entries, so two rounds whose purchases are identical, on the same core or on different ones, share a commitment. Always read a round's logs filtered by the core's address.

The core contract is **not upgradeable**. It is deployed directly, not behind a proxy. Both EIP-1967 slots (implementation and admin) read zero, so the code at the address, and with it the immutable `vrfCoordinator()`, cannot be replaced.

The VRF coordinator is deliberately **not** in this table. A verifier takes it from Chainlink's own documentation (§8 step 6).

### Where each on-chain value is read

Everything below comes from logs, plus view calls at the latest block. Many public RPC endpoints prune historical state, so a verifier that depended on reading state at a past block could not run against them.

- **Commitment, total tickets, commit block:** `EntryCommitted`. The contract updates the running commitment only while the round is open, and freezing the round closes it. So there is one commitment per round, used unchanged by every nonce. §8 step 5 confirms the commitment is unique and final (see the structural checks), and that `roundOf(roundId)` at the latest block still reports the same `entryCommitment`. `roundOf` returns the static tuple `(uint8, uint8, uint64, uint64, bytes32)`, so the words are status, current nonce, commit block, total tickets and commitment, in that order.
- **One draw's state:** `drawOf(uint256 roundId, uint256 drawNonce)` returns the static tuple `(bool, uint8, uint64, uint64, uint64, address, uint64, uint256, bytes32)`. The words that matter here are the sixth (winner), seventh (winning index), eighth (the `requestId` whose fulfilment supplied the seed) and ninth (seed). §8's "Logs agree with current state" check compares these with the logs.
- **Request, seed and winner for each nonce:** `RandomnessRequested`, `RandomnessFulfilled` and `WinnerSelected`, matched on `roundId` and the `drawNonce` in their data.
- **The round's `prizeDescriptorHash` (§9):** from `RoundOpened`, emitted once when the round opens. Its topic signature is `RoundOpened(uint256,uint256,(uint8,bytes32,uint64,uint64,uint32,uint8,uint64,uint32,uint64,uint32,uint16))`. `roundId` and `marketId` are indexed, and the tuple is static, so the data is eleven 32-byte words and `prizeDescriptorHash` is the second. The round keeps its own copy from opening, so the hash cannot drift with the market's later terms.
- **The descriptor text** is not on-chain. A verifier hashes whatever bytes it is given (§9) and compares the result with the hash above, so the text can come from anywhere without being trusted.
