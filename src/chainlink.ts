// Chainlink's VRF v2.5 coordinator for each chain, copied by hand from
// Chainlink's own documentation.
//
// This table is the reason the seed check means anything. The core's
// vrfCoordinator() is compared against it, and the seed is traced to a log
// emitted by that address (PUBLIC-SPEC §8 steps 6–7). The operator's copy of
// this address is exactly the value under test, so it is never read from the
// contracts package, the website, the spec's deployment table, or anything
// else the operator publishes. If Chainlink moves a coordinator, this table
// is updated by hand from Chainlink's page, with the new date.

export interface Coordinator {
  chainId: bigint;
  chain: string;
  address: bigint;
  source: string;
  retrieved: string;
}

const SOURCE = 'https://docs.chain.link/vrf/v2-5/supported-networks';

export const CHAINLINK_VRF_COORDINATORS: readonly Coordinator[] = [
  { chainId: 56n, chain: 'BNB Chain mainnet', address: 0xd691f04bc0c9a24edb78af9e005cf85768f694c9n, source: SOURCE, retrieved: '2026-10-27' },
  { chainId: 97n, chain: 'BNB Chain testnet', address: 0xda3b641d438362c440ac5458c57e00a712b66700n, source: SOURCE, retrieved: '2026-10-27' },
];

export function coordinatorFor(chainId: bigint): Coordinator | undefined {
  return CHAINLINK_VRF_COORDINATORS.find((c) => c.chainId === chainId);
}
