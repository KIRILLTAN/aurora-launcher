import type { CatalogItem, CatalogVersion, LoaderType } from '@shared/types'
import { fetchJson } from '../util/net'

const API = 'https://api.modrinth.com/v2'

interface MrHit {
  project_id: string
  slug: string
  title: string
  description: string
  author: string
  icon_url?: string
  downloads: number
  follows: number
  categories: string[]
  versions: string[]
  project_type: string
}

export interface MrVersion {
  id: string
  project_id: string
  name: string
  version_number: string
  game_versions: string[]
  loaders: string[]
  date_published: string
  downloads: number
  files: { url: string; filename: string; primary: boolean; size: number; hashes: { sha1: string; sha512: string } }[]
  dependencies: { project_id?: string; version_id?: string; dependency_type: 'required' | 'optional' | 'incompatible' | 'embedded' }[]
}

export async function searchModrinth(opts: {
  query: string
  type: 'modpack' | 'mod' | 'resourcepack' | 'shader'
  gameVersion?: string
  loader?: LoaderType
  sort?: 'relevance' | 'downloads' | 'follows' | 'newest' | 'updated'
  offset?: number
}): Promise<{ items: CatalogItem[]; total: number }> {
  const facets: string[][] = [[`project_type:${opts.type}`]]
  if (opts.gameVersion) facets.push([`versions:${opts.gameVersion}`])
  if (opts.loader && opts.loader !== 'vanilla' && opts.type === 'mod') facets.push([`categories:${opts.loader}`])
  const params = new URLSearchParams({
    query: opts.query,
    facets: JSON.stringify(facets),
    index: opts.sort || 'relevance',
    limit: '24',
    offset: String(opts.offset || 0)
  })
  const r = await fetchJson<{ hits: MrHit[]; total_hits: number }>(`${API}/search?${params}`)
  return {
    total: r.total_hits,
    items: r.hits.map((h) => ({
      source: 'modrinth',
      id: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      author: h.author,
      icon: h.icon_url,
      downloads: h.downloads,
      follows: h.follows,
      categories: h.categories,
      versions: h.versions,
      url: `https://modrinth.com/${h.project_type}/${h.slug}`
    }))
  }
}

export async function modrinthVersions(projectId: string, gameVersion?: string, loader?: string): Promise<MrVersion[]> {
  const params = new URLSearchParams()
  if (gameVersion) params.set('game_versions', JSON.stringify([gameVersion]))
  if (loader && loader !== 'vanilla') params.set('loaders', JSON.stringify(loader === 'quilt' ? ['quilt', 'fabric'] : [loader]))
  return fetchJson<MrVersion[]>(`${API}/project/${projectId}/version?${params}`)
}

export function toCatalogVersion(v: MrVersion): CatalogVersion {
  return {
    id: v.id,
    name: v.name,
    versionNumber: v.version_number,
    gameVersions: v.game_versions,
    loaders: v.loaders,
    date: v.date_published,
    downloads: v.downloads,
    fileName: v.files.find((f) => f.primary)?.filename || v.files[0]?.filename
  }
}

export function getModrinthVersion(id: string): Promise<MrVersion> {
  return fetchJson<MrVersion>(`${API}/version/${id}`)
}

export function getModrinthProject(id: string): Promise<{ id: string; title: string; icon_url?: string; body: string; description: string; gallery: { url: string }[] }> {
  return fetchJson(`${API}/project/${id}`)
}
