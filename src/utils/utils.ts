import { IPFS_GATEWAY } from '@/constants';

// Pasted tokenIds often carry surrounding whitespace/newlines (or an "0x" prefix
// copied from a block explorer), which would end up in the query and the URL.
export function sanitizeTokenId(input: string){
  const stripped = input.replace(/\s+/g, '');
  const withoutPrefix = /^0x[0-9a-fA-F]+$/.test(stripped) ? stripped.slice(2) : stripped;
  // Leave anything that isn't plain hex untouched so the user sees what they entered
  return /^[0-9a-fA-F]+$/.test(withoutPrefix) ? withoutPrefix.toLowerCase() : withoutPrefix;
}

export function formatTimestamp(unixTimestampNumber: number){
  const date = new Date(unixTimestampNumber * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');

  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

// Browsers can't open ipfs:// links, so route them through the configured gateway.
// Other schemes are returned unchanged.
export function ipfsToGatewayUrl(uri: string){
  return uri.startsWith('ipfs://') ? IPFS_GATEWAY + uri.slice('ipfs://'.length) : uri;
}
