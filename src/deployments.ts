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
  { chainId: 97n, core: 0xa0ca23bfb669acad267a1acaf142cd4b3415e759n, fromBlock: 139115294n },
];

export function defaultCoreFor(chainId: bigint): Deployment | undefined {
  return DEFAULT_CORES.find((d) => d.chainId === chainId);
}
