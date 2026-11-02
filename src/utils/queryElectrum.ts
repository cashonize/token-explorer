import { initializeElectrumClient, fetchUnspentTransactionOutputs } from '@electrum-cash/protocol'
import { lockingBytecodeToCashAddress, hexToBin } from '@bitauth/libauth'
import { ELECTRUM_MAINNET, ELECTRUM_CHIPNET } from '@/constants'
import type { ElectrumVerification } from '@/interfaces'

interface ChaingraphOutput {
  transaction_hash: string
  output_index: string
  locking_bytecode: string
  fungible_token_amount?: string | null
  nonfungible_token_capability?: string | null
}

export async function verifySupplyViaElectrum(
  chaingraphOutputs: ChaingraphOutput[],
  tokenId: string,
  network: 'mainnet' | 'chipnet',
  authHead?: { txHash: string, vout: number, address?: string }
): Promise<ElectrumVerification> {
  const hostname = network === 'chipnet' ? ELECTRUM_CHIPNET : ELECTRUM_MAINNET
  const prefix = network === 'chipnet' ? 'bchtest' : 'bitcoincash'

  console.time('electrum:total')

  // Group Chaingraph outputs by locking bytecode
  const outputsByBytecode = new Map<string, ChaingraphOutput[]>()
  for (const output of chaingraphOutputs) {
    const bc = output.locking_bytecode.slice(2) // remove \x prefix
    const existing = outputsByBytecode.get(bc)
    if (existing) {
      existing.push(output)
    } else {
      outputsByBytecode.set(bc, [output])
    }
  }

  // Build bytecode → CashAddress map
  const bytecodeToAddress = new Map<string, string>()
  for (const bc of outputsByBytecode.keys()) {
    const result = lockingBytecodeToCashAddress({ bytecode: hexToBin(bc), prefix })
    if (typeof result !== 'string') {
      bytecodeToAddress.set(bc, result.address)
    }
  }

  // Build Chaingraph UTXO map for matching + lookup
  const chaingraphUtxoByKey = new Map<string, ChaingraphOutput>()
  for (const output of chaingraphOutputs) {
    const txHash = output.transaction_hash.slice(2) // remove \x prefix
    const vout = output.output_index
    chaingraphUtxoByKey.set(`${txHash}:${vout}`, output)
  }
  const chaingraphUtxoSet = new Set(chaingraphUtxoByKey.keys())

  let chaingraphTotalFT = 0n
  for (const output of chaingraphOutputs) {
    chaingraphTotalFT += BigInt(output.fungible_token_amount ?? '0')
  }

  // Deduplicate addresses
  const uniqueAddresses = [...new Set(bytecodeToAddress.values())]
  console.log(`electrum: ${chaingraphOutputs.length} UTXOs across ${uniqueAddresses.length} unique addresses`)

  // network 4.x dropped disableBrowserVisibilityHandling: hiding the tab closes the socket, which fails in-flight requests
  const client = await initializeElectrumClient('Token Explorer', hostname)

  try {
    // connect once up front: otherwise every parallel request retries connect serially and disconnect() waits behind them
    console.time('electrum:connect')
    await client.connect()
    console.timeEnd('electrum:connect')

    let totalElectrumUtxos = 0
    let electrumTotalFT = 0n
    let electrumReservedFT = 0n
    const electrumUtxoSet = new Set<string>()
    const electrumUtxoByKey = new Map<string, { amount: string; capability?: string }>()

    console.time('electrum:queries')
    const allResults = await Promise.all(
      uniqueAddresses.map(address => fetchUnspentTransactionOutputs(client, address, true, true))
    )
    console.timeEnd('electrum:queries')

    for (const utxos of allResults) {
      const tokenUtxos = utxos.filter(u =>
        u.token_data && u.token_data.category === tokenId
      )

      totalElectrumUtxos += tokenUtxos.length

      for (const utxo of tokenUtxos) {
        const key = `${utxo.tx_hash}:${utxo.tx_pos}`
        electrumUtxoSet.add(key)
        electrumUtxoByKey.set(key, {
          amount: utxo.token_data?.amount ?? '0',
          capability: utxo.token_data?.nft?.capability,
        })

        const ftAmount = BigInt(utxo.token_data?.amount ?? '0')
        electrumTotalFT += ftAmount

        // Reserved = FT on minting/mutable NFT outputs + authhead identity output
        const capability = utxo.token_data?.nft?.capability
        const isAuthhead = authHead && utxo.tx_hash === authHead.txHash && utxo.tx_pos === authHead.vout
        if (capability === 'minting' || capability === 'mutable' || isAuthhead) {
          electrumReservedFT += ftAmount
        }
      }
    }

    // Count stale: in Chaingraph but not in Electrum
    const staleUtxos: { key: string; ftAmount: string; capability: string | null; address?: string }[] = []
    for (const key of chaingraphUtxoSet) {
      if (!electrumUtxoSet.has(key)) {
        const output = chaingraphUtxoByKey.get(key)!
        const bc = output.locking_bytecode.slice(2)
        staleUtxos.push({
          key,
          ftAmount: output.fungible_token_amount ?? '0',
          capability: output.nonfungible_token_capability ?? null,
          address: bytecodeToAddress.get(bc),
        })
      }
    }
    const staleCount = staleUtxos.length

    // Count missing: in Electrum but not in Chaingraph
    const missingUtxos: { key: string; ftAmount: string; capability?: string }[] = []
    for (const key of electrumUtxoSet) {
      if (!chaingraphUtxoSet.has(key)) {
        const data = electrumUtxoByKey.get(key)!
        missingUtxos.push({ key, ftAmount: data.amount, capability: data.capability })
      }
    }
    const missingCount = missingUtxos.length

    if (staleCount > 0) {
      console.warn(`electrum: ${staleCount} stale UTXO${staleCount > 1 ? 's' : ''} reported by Chaingraph but not found by Electrum (likely already spent):`)
      console.table(staleUtxos)
    }
    if (missingCount > 0) {
      console.warn(`electrum: ${missingCount} UTXO${missingCount > 1 ? 's' : ''} found by Electrum but not yet in Chaingraph:`)
      console.table(missingUtxos)
    }

    // Check if authhead UTXO is unspent according to Electrum
    let authHeadUnspent: boolean | undefined
    if (authHead) {
      authHeadUnspent = electrumUtxoSet.has(`${authHead.txHash}:${authHead.vout}`)

      // If not found yet, the authhead address might not be in allTokenOutputs
      // (e.g. identity output without tokens). Query its address directly.
      if (!authHeadUnspent && authHead.address) {
        const authUtxos = await fetchUnspentTransactionOutputs(client, authHead.address, true, true)
        authHeadUnspent = authUtxos.some(
          u => u.tx_hash === authHead.txHash && u.tx_pos === authHead.vout
        )
      }
    }

    const verified = staleCount === 0 && missingCount === 0
    console.timeEnd('electrum:total')
    console.log(`electrum: result — ${totalElectrumUtxos} UTXOs, ${staleCount} stale, ${missingCount} missing, verified=${verified}, authHeadUnspent=${authHeadUnspent}`)

    return {
      verified,
      totalChaingraphUtxos: chaingraphOutputs.length,
      totalElectrumUtxos,
      staleCount,
      missingCount,
      chaingraphTotalFT,
      electrumTotalFT,
      electrumReservedFT,
      authHeadUnspent,
    }
  } finally {
    try { await client.disconnect() } catch { /* ignore disconnect errors */ }
  }
}
