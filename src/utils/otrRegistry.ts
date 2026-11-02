import { OTR_REGISTRY_URL } from '@/constants'
import { RegistrySchema, type ValidatedRegistry } from './bcmrSchema'

let otrRegistry: ValidatedRegistry | null = null
let otrRegistryPromise: Promise<ValidatedRegistry | null> | null = null

// retryable: a network error or non-2xx response, worth fetching again on the next lookup.
// A registry that fails schema validation is not retried, so it isn't re-downloaded every lookup.
async function fetchOtrRegistry(): Promise<{ registry: ValidatedRegistry | null, retryable: boolean }> {
  try {
    const response = await fetch(OTR_REGISTRY_URL)
    if (!response.ok) {
      console.error(`Failed to fetch OTR registry: ${response.status}`)
      return { registry: null, retryable: true }
    }
    const data = await response.json()
    const result = RegistrySchema.safeParse(data)
    if (!result.success) {
      console.error('OTR registry validation failed:', result.error.issues)
      return { registry: null, retryable: false }
    }
    return { registry: result.data, retryable: false }
  } catch (error) {
    console.error('Error fetching OTR registry:', error)
    return { registry: null, retryable: true }
  }
}

export async function checkOtrVerified(tokenId: string): Promise<boolean> {
  // Use cached registry if available
  if (!otrRegistry) {
    // Avoid multiple concurrent fetches; clear the shared promise after a retryable
    // failure so the next lookup fetches again
    if (!otrRegistryPromise) {
      otrRegistryPromise = fetchOtrRegistry().then(({ registry, retryable }) => {
        if (retryable) otrRegistryPromise = null
        return registry
      })
    }
    otrRegistry = await otrRegistryPromise
  }

  if (!otrRegistry?.identities) {
    return false
  }

  return tokenId in otrRegistry.identities
}
