import fs from 'fs'
import path from 'path'
import type { McVersion } from '@shared/types'
import { dirs } from '../settings'
import { fetchJson } from '../util/net'
import { readJson, writeJson, exists } from '../util/store'

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'

export interface Rule {
  action: 'allow' | 'disallow'
  os?: { name?: string; arch?: string; version?: string }
  features?: Record<string, boolean>
}

export interface Artifact {
  path?: string
  url?: string
  sha1?: string
  size?: number
}

export interface Library {
  name: string
  url?: string
  rules?: Rule[]
  natives?: Record<string, string>
  extract?: { exclude?: string[] }
  downloads?: { artifact?: Artifact; classifiers?: Record<string, Artifact> }
  clientreq?: boolean
  checksums?: string[]
}

export type Argument = string | { rules?: Rule[]; value: string | string[] }

export interface VersionJson {
  id: string
  inheritsFrom?: string
  jar?: string
  type?: string
  mainClass: string
  minecraftArguments?: string
  arguments?: { game?: Argument[]; jvm?: Argument[] }
  libraries: Library[]
  assetIndex?: { id: string; url: string; sha1: string; size?: number; totalSize?: number }
  assets?: string
  downloads?: { client?: Artifact; client_mappings?: Artifact }
  javaVersion?: { component?: string; majorVersion: number }
  logging?: { client?: { argument: string; file: { id: string; url: string; sha1: string; size: number } } }
  releaseTime?: string
}

interface Manifest {
  latest: { release: string; snapshot: string }
  versions: (McVersion & { url: string; sha1: string })[]
}

let manifest: Manifest | null = null

export async function getManifest(force = false): Promise<Manifest> {
  if (manifest && !force) return manifest
  const cacheFile = path.join(dirs.cache(), 'version_manifest_v2.json')
  try {
    manifest = await fetchJson<Manifest>(MANIFEST_URL)
    writeJson(cacheFile, manifest)
  } catch (e) {
    const cached = readJson<Manifest | null>(cacheFile, null)
    if (!cached) throw e
    manifest = cached
  }
  return manifest
}

export async function listVersions(): Promise<McVersion[]> {
  const m = await getManifest()
  return m.versions.map(({ id, type, releaseTime }) => ({ id, type, releaseTime }))
}

export function versionJsonPath(id: string): string {
  return path.join(dirs.versions(), id, `${id}.json`)
}

/** Загружает json версии: локально или из манифеста Mojang. */
export async function loadVersionJson(id: string): Promise<VersionJson> {
  const file = versionJsonPath(id)
  if (exists(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as VersionJson
  }
  const m = await getManifest()
  const entry = m.versions.find((v) => v.id === id)
  if (!entry) throw new Error(`Версия ${id} не найдена`)
  const json = await fetchJson<VersionJson>(entry.url)
  writeJson(file, json)
  return json
}

export interface ResolvedVersion extends VersionJson {
  /** id версии, чей client.jar используется (корень цепочки inheritsFrom) */
  rootId: string
  chain: string[]
}

/** Сливает цепочку inheritsFrom (загрузчик -> ванилла) в одну версию. */
export async function resolveVersion(id: string): Promise<ResolvedVersion> {
  const chain: VersionJson[] = []
  let cur: string | undefined = id
  while (cur) {
    if (chain.some((c) => c.id === cur)) throw new Error(`Циклическое наследование версии ${cur}`)
    const v: VersionJson = await loadVersionJson(cur)
    chain.push(v)
    cur = v.inheritsFrom
  }
  let result = chain[chain.length - 1] as VersionJson
  for (let i = chain.length - 2; i >= 0; i--) result = merge(chain[i], result)
  return { ...result, id, rootId: chain[chain.length - 1].id, chain: chain.map((c) => c.id) }
}

function merge(child: VersionJson, parent: VersionJson): VersionJson {
  const out: VersionJson = { ...parent, ...child }
  out.libraries = [...(child.libraries || []), ...(parent.libraries || [])]
  if (child.arguments || parent.arguments) {
    out.arguments = {
      game: [...(parent.arguments?.game || []), ...(child.arguments?.game || [])],
      jvm: [...(parent.arguments?.jvm || []), ...(child.arguments?.jvm || [])]
    }
  }
  out.minecraftArguments = child.minecraftArguments || parent.minecraftArguments
  out.assetIndex = child.assetIndex || parent.assetIndex
  out.assets = child.assets || parent.assets
  out.downloads = child.downloads || parent.downloads
  out.javaVersion = child.javaVersion || parent.javaVersion
  out.logging = child.logging || parent.logging
  out.inheritsFrom = undefined
  return out
}

export function osName(): 'windows' | 'osx' | 'linux' {
  return process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
}

export function osArch(): string {
  return process.arch === 'ia32' ? 'x86' : process.arch
}

export function rulesAllow(rules: Rule[] | undefined, features: Record<string, boolean> = {}): boolean {
  if (!rules || rules.length === 0) return true
  let allowed = false
  for (const r of rules) {
    let match = true
    if (r.os) {
      if (r.os.name && r.os.name !== osName()) match = false
      if (r.os.arch && r.os.arch !== osArch()) match = false
    }
    if (r.features) {
      for (const [k, v] of Object.entries(r.features)) if (!!features[k] !== v) match = false
    }
    if (match) allowed = r.action === 'allow'
  }
  return allowed
}

/** group:artifact:version[:classifier][@ext] -> путь в maven-репозитории */
export function mavenPath(coord: string): string {
  let ext = 'jar'
  let c = coord
  const at = c.indexOf('@')
  if (at >= 0) {
    ext = c.slice(at + 1)
    c = c.slice(0, at)
  }
  const [group, artifact, version, classifier] = c.split(':')
  const file = `${artifact}-${version}${classifier ? '-' + classifier : ''}.${ext}`
  return [...group.split('.'), artifact, version, file].join('/')
}

/** Сравнение версий Minecraft вида 1.20.1 (снапшоты считаются по дате в манифесте). */
export function compareMc(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => parseInt(x) || 0)
  const pb = b.split(/[.-]/).map((x) => parseInt(x) || 0)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0)
    if (d) return d
  }
  return 0
}
