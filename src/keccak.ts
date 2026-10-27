// Every hash in the protocol is keccak256. The pure modules take it as a
// parameter rather than importing it, so the package runs anywhere: the CLI
// passes the platform's implementation (node-keccak.ts), and a browser consumer passes
// its own and must run the same vectors against it.
export type Keccak256 = (data: Uint8Array) => Uint8Array;
