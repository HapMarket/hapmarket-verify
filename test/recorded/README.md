# Recorded draws

JSON-RPC answers recorded while the verifier ran (`scripts/record.ts`), replayed in CI so the full verification
runs deterministically on draws whose logs public nodes have since pruned.
They are recordings of public chain data, not operator files. Anyone can check
a recording against an endpoint that serves full log history.

Each file is one snapshot: every round in it was read at the same pinned
block. Replay answers a log query only if the recording covered that range, so
a query the endpoint never answered fails instead of returning nothing. The
`endpoint` field is the host only; provider URLs often carry an API key.

| File | Core | Captured | What it exercises |
|---|---|---|---|
| `97-1d1da09e.json` | `0x1d1da09e…db9d` (current, v3) | 2026-10-28, publicnode | Round 1: a plain real-VRF draw on the core with one live request per nonce, nonce 1, settled. |
| `97-a0ca23bf.json` | `0xa0ca23bf…e759` (superseded) | 2026-10-28, NodeReal | Round 1: a plain real-VRF draw, nonce 1, settled. |
| `97-d64634cc.json` | `0xd64634cc…5bd3` (superseded) | 2026-10-28, NodeReal | Rounds 1 and 2 running side by side. Round 1 is drawn and awaiting the Part C forfeit and redraw (claim window closes 2026-11-22 22:49:37 UTC). Re-record after the redraw. |
| `97-fe9439c8.json` | `0xfe9439c8…d12b` (retry test) | 2026-10-28, NodeReal | Round 1: two requests at nonce 1, both fulfilled in one transaction with `success = true`. The fulfilling node chose which seed counted, so the round **fails** `vrf.oneSuccess`, and is kept as the case that proves the check works. This core predates the contract fix that allows only one live request per nonce. |

The refund paths have no real draw yet; `recorded.test.ts` builds each one by rewriting the settled round's history.

All on BNB Chain testnet (chain 97). Coordinator `0xDA3b641D438362C440Ac5458c57e00a712b66700`.
