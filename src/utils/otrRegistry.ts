import { OTR_REGISTRY_URL } from '@/constants'
import { RegistrySchema, type ValidatedRegistry } from './bcmrSchema'

let otrRegistry: ValidatedRegistry | null = null
let otrRegistryPromise: Promise<ValidatedRegistry | null> | null = null

async function fetchOtrRegistry(): Promise<ValidatedRegistry | null> {
  try {
    const response = await fetch(OTR_REGISTRY_URL)
    if (!response.ok) {
      console.error(`Failed to fetch OTR registry: ${response.status}`)
      return null
    }
    const data = await response.json()
    const result = RegistrySchema.safeParse(data)
    if (!result.success) {
      console.error('OTR registry validation failed:', result.error.issues)
      return null
    }
    return result.data
  } catch (error) {
    console.error('Error fetching OTR registry:', error)
    return null
  }
}

export async function checkOtrVerified(tokenId: string): Promise<boolean> {
  // Use cached registry if available
  if (!otrRegistry) {
    // Avoid multiple concurrent fetches
    if (!otrRegistryPromise) {
      const promise = fetchOtrRegistry()
      otrRegistryPromise = promise
      // Don't cache a failed fetch: clear the shared promise so the next lookup retries
      promise.then(result => {
        if (!result && otrRegistryPromise === promise) otrRegistryPromise = null
      })
    }
    otrRegistry = await otrRegistryPromise
  }

  if (!otrRegistry?.identities) {
    return false
  }

  return tokenId in otrRegistry.identities
}
