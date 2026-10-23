import type { CatalogItem, CatalogVersion, LoaderType } from '@shared/types'
import { getSettings } from '../settings'
import { fetchJson } from '../util/net'

const API = 'https://api.curseforge.com/v1'
const GAME = 432
export const CF_CLASS = { mod: 6, modpack: 4471, resourcepack: 12, shader: 6552 } as const
const LOADER_ID: Record<string, number> = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 }

function headers(): Record<string, string> {
  const key = getSettings().curseforgeKey
  if (!key) throw new Error('Для CurseForge нужен API-ключ: получите его на console.curseforge.com и вставьте в Настройки')
  return { 'x-api-key': key }
}

export function cfGet<T>(path: string): Promise<T> {
  return fetchJson<T>(API + path, { headers: headers() })
}
export function cfPost<T>(path: string, body: unknown): Promise<T> {
  return fetchJson<T>(API + path, { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

interface CfMod {
  id: number
  name: string
  slug: string
  summary: string
  downloadCount: number
  classId: number
  logo?: { thumbnailUrl: string; url: string }
  authors: { name: string }[]
  categories: { name: string }[]
  latestFilesIndexes: { gameVersion: string }[]
  links?: { websiteUrl?: string }
}

export interface CfFile {
  id: number
  modId: number
  displayName: string
  fileName: string
  fileDate: string
  downloadCount: number
  downloadUrl: string | null
  gameVersions: string[]
  hashes: { value: string; algo: number }[]
  fileLength: number
}

export async function searchCurseforge(opts: {
  query: string
  type: keyof typeof CF_CLASS
  gameVersion?: string
  loader?: LoaderType
  offset?: number
}): Promise<{ items: CatalogItem[]; total: number }> {
  const p = new URLSearchParams({
    gameId: String(GAME),
    classId: String(CF_CLASS[opts.type]),
    searchFilter: opts.query,
    sortField: '2',
    sortOrder: 'desc',
    pageSize: '24',
    index: String(opts.offset || 0)
  })
  if (opts.gameVersion) p.set('gameVersion', opts.gameVersion)
  if (opts.loader && LOADER_ID[opts.loader] && opts.type === 'mod') p.set('modLoaderType', String(LOADER_ID[opts.loader]))
  const r = await cfGet<{ data: CfMod[]; pagination: { totalCount: number } }>(`/mods/search?${p}`)
  return {
    total: r.pagination.totalCount,
    items: r.data.map((m) => ({
      source: 'curseforge',
      id: String(m.id),
      slug: m.slug,
      title: m.name,
      description: m.summary,
      author: m.authors[0]?.name,
      icon: m.logo?.thumbnailUrl,
      downloads: m.downloadCount,
      categories: m.categories.map((c) => c.name),
      versions: [...new Set(m.latestFilesIndexes.map((f) => f.gameVersion))],
      url: m.links?.websiteUrl
    }))
  }
}

export async function curseforgeFiles(modId: string, gameVersion?: string, loader?: string): Promise<CatalogVersion[]> {
  const p = new URLSearchParams({ pageSize: '50' })
  if (gameVersion) p.set('gameVersion', gameVersion)
  if (loader && LOADER_ID[loader]) p.set('modLoaderType', String(LOADER_ID[loader]))
  const r = await cfGet<{ data: CfFile[] }>(`/mods/${modId}/files?${p}`)
  return r.data.map((f) => ({
    id: String(f.id),
    name: f.displayName,
    versionNumber: f.displayName,
    gameVersions: f.gameVersions.filter((g) => /^\d/.test(g)),
    loaders: f.gameVersions.filter((g) => /forge|fabric|quilt|neoforge/i.test(g)).map((g) => g.toLowerCase()),
    date: f.fileDate,
    downloads: f.downloadCount,
    fileName: f.fileName
  }))
}

/** Прямая ссылка; для файлов с запретом сторонней раздачи собираем адрес CDN вручную. */
export function cfDownloadUrl(f: CfFile): string {
  if (f.downloadUrl) return f.downloadUrl
  const id = String(f.id)
  return `https://edge.forgecdn.net/files/${id.slice(0, -3)}/${parseInt(id.slice(-3))}/${encodeURIComponent(f.fileName)}`
}

export function cfSha1(f: CfFile): string | undefined {
  return f.hashes.find((h) => h.algo === 1)?.value
}
