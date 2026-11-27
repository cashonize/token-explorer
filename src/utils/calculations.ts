interface OutputWithLockingBytecode {
  transaction_hash: string
  output_index: string
  locking_bytecode: string
  fungible_token_amount?: string | null
  nonfungible_token_capability?: string | null
}

/**
 * Holder counts and the circulating FT split between user (P2PKH) and smart-contract
 * addresses. `outputs` are the unspent token outputs with known burns already removed.
 * Reserved outputs (`reservedOutpoints`, "txHash:vout", plus any minting/mutable NFT
 * output) are left out of the split, so for Chaingraph data:
 *   userSupplyFT + contractSupplyFT = unspent − reserved
 *                                   = circulating (excl. burns)
 * Address counts still include addresses that only hold reserved outputs.
 */
export function countUniqueHolders(
  outputs: OutputWithLockingBytecode[],
  reservedOutpoints: ReadonlySet<string> = new Set()
): { numberHolders: number, numberTokenAddresses: number, userSupplyFT: bigint, contractSupplyFT: bigint } {
  const uniqueLockingBytecodes = new Set(outputs.map(output => output.locking_bytecode.slice(2)));
  const numberHolders = Array.from(uniqueLockingBytecodes).filter(locking_bytecode =>
    locking_bytecode.startsWith('76a914')
  ).length;
  const numberTokenAddresses = uniqueLockingBytecodes.size;

  let userSupplyFT = 0n;
  let contractSupplyFT = 0n;
  for (const output of outputs) {
    const isReserved = output.nonfungible_token_capability === 'minting' || output.nonfungible_token_capability === 'mutable' ||
      reservedOutpoints.has(`${output.transaction_hash.slice(2)}:${output.output_index}`);
    if (isReserved) continue;
    const ft = BigInt(output.fungible_token_amount ?? "0");
    if (output.locking_bytecode.slice(2).startsWith('76a914')) {
      userSupplyFT += ft;
    } else {
      contractSupplyFT += ft;
    }
  }

  return { numberHolders, numberTokenAddresses, userSupplyFT, contractSupplyFT }
}

export function calculateTotalSupplyFT(outputs: OutputWithLockingBytecode[]): bigint {
  return outputs.reduce(
    (total: bigint, output) =>
      total + BigInt(output.fungible_token_amount ?? "0"),
    0n
  );
}
