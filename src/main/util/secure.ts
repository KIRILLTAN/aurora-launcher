import { safeStorage } from 'electron'

/** Шифрует JSON средствами ОС (DPAPI/Keychain/libsecret), если доступно. */
export function sealJson(o: unknown): string {
  const json = JSON.stringify(o)
  if (safeStorage.isEncryptionAvailable()) return 'enc:' + safeStorage.encryptString(json).toString('base64')
  return 'raw:' + Buffer.from(json).toString('base64')
}

export function unsealJson<T>(v: string | undefined): T | null {
  if (!v) return null
  try {
    if (v.startsWith('enc:')) return JSON.parse(safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'))) as T
    if (v.startsWith('raw:')) return JSON.parse(Buffer.from(v.slice(4), 'base64').toString()) as T
  } catch {
    /* повреждено */
  }
  return null
}
