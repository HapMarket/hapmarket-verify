// Default core contract per chain, from PUBLIC-SPEC §10. This is only a
// convenience so the common case needs no flags. It is the operator's
// statement of which contract to read, and nothing is trusted because of it:
// every check below holds for whatever core is named, and `--core` with
// `--from-block` reads any other, including superseded cores.
//
// fromBlock is the block the core was created in. Scanning from there is
// complete, since no log can come before the contract exists.

export interface Deployment {
  chainId: bigint;
  core: bigint;
  fromBlock: bigint;
}

export const DEFAULT_CORES: readonly Deployment[] = [
  { chainId: 97n, core: 0x1d1da09ee37569fcf2351c3d0cfed43fc7d8db9dn, fromBlock: 139445712n },
];

export function defaultCoreFor(chainId: bigint): Deployment | undefined {
  return DEFAULT_CORES.find((d) => d.chainId === chainId);
}
