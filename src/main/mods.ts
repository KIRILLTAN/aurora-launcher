import fs from 'fs'
import path from 'path'
import type { ModInfo } from '@shared/types'
import { gameDir } from './instances'
import { dirs } from './settings'
import { ensureDir, exists, readJson } from './util/store'
import { entryBuffer, walkZip } from './util/zip'

export interface ModMeta extends ModInfo {
  packages: string[]
  depends: string[]
}

function parseToml(text: string): { mods: Record<string, string>[]; deps: string[] } {
  const mods: Record<string, string>[] = []
  const deps: string[] = []
  let cur: Record<string, string> | null = null
  let inDeps = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('[[mods]]')) {
      cur = {}
      mods.push(cur)
      inDeps = false
      continue
    }
    if (line.startsWith('[[dependencies')) {
      cur = null
      inDeps = true
      continue
    }
    const m = /^([A-Za-z]+)\s*=\s*"([^"]*)"/.exec(line)
    if (!m) continue
    if (cur) cur[m[1]] = m[2]
    else if (inDeps && m[1] === 'modId' && !['forge', 'minecraft', 'neoforge', 'java'].includes(m[2])) deps.push(m[2])
  }
  return { mods, deps }
}

const META_FILES = ['fabric.mod.json', 'quilt.mod.json', 'META-INF/mods.toml', 'META-INF/neoforge.mods.toml', 'mcmod.info']

/**
 * Читает из jar только оглавление и несколько маленьких файлов метаданных.
 * Раньше jar загружался в память целиком (у Create это десятки МБ) — отсюда фризы.
 */
async function scanJar(file: string): Promise<{ texts: Map<string, string>; classes: string[] }> {
  const texts = new Map<string, string>()
  const classes: string[] = []
  await walkZip(file, async (e, zip) => {
    if (e.fileName.endsWith('.class')) classes.push(e.fileName)
    else if (META_FILES.includes(e.fileName) && e.uncompressedSize < 2_000_000) texts.set(e.fileName, (await entryBuffer(zip, e)).toString('utf8'))
  }).catch(() => undefined)
  return { texts, classes }
}

/** Читает метаданные мода: fabric.mod.json / quilt.mod.json / mods.toml / mcmod.info */
export async function readModMeta(file: string): Promise<ModMeta> {
  const st = await fs.promises.stat(file)
  const base = path.basename(file)
  const meta: ModMeta = {
    file: base,
    enabled: !base.endsWith('.disabled'),
    name: base.replace(/\.disabled$/, '').replace(/\.jar$/, ''),
    loaders: [],
    size: st.size,
    packages: [],
    depends: []
  }
  const { texts, classes } = await scanJar(file)
  const read = (n: string): string | null => texts.get(n) ?? null
  try {
    const fabric = read('fabric.mod.json')
    if (fabric) {
      const j = JSON.parse(fabric.replace(/[\u0000-\u001f]+/g, ' '))
      meta.id = j.id
      meta.name = j.name || j.id || meta.name
      meta.version = j.version
      meta.description = j.description
      meta.loaders.push('fabric')
      meta.depends = Object.keys(j.depends || {}).filter((d) => !['minecraft', 'java', 'fabricloader', 'fabric-loader'].includes(d))
    }
    const quilt = read('quilt.mod.json')
    if (quilt) {
      const j = JSON.parse(quilt).quilt_loader || {}
      meta.id = meta.id || j.id
      meta.name = j.metadata?.name || meta.name
      meta.version = meta.version || j.version
      meta.loaders.push('quilt')
    }
    for (const tomlName of ['META-INF/mods.toml', 'META-INF/neoforge.mods.toml']) {
      const toml = read(tomlName)
      if (!toml) continue
      const t = parseToml(toml)
      const m = t.mods[0]
      if (m) {
        meta.id = meta.id || m.modId
        meta.name = m.displayName || meta.name
        meta.version = meta.version || m.version
        meta.description = meta.description || m.description
      }
      meta.depends.push(...t.deps)
      meta.loaders.push(tomlName.includes('neoforge') ? 'neoforge' : 'forge')
    }
    const info = read('mcmod.info')
    if (info && !meta.id) {
      const j = JSON.parse(info)
      const m = Array.isArray(j) ? j[0] : j.modList?.[0]
      if (m) {
        meta.id = m.modid
        meta.name = m.name || meta.name
        meta.version = m.version
        meta.description = m.description
      }
      meta.loaders.push('forge')
    }
  } catch {
    /* некорректные метаданные — оставляем имя файла */
  }
  if (meta.version?.includes('${')) meta.version = undefined
  // пакеты классов мода (для поиска мода по стектрейсу)
  const pkgs = new Map<string, number>()
  for (const name of classes) {
    const parts = name.split('/')
    if (parts.length < 4) continue
    const p = parts.slice(0, Math.min(3, parts.length - 1)).join('.')
    pkgs.set(p, (pkgs.get(p) || 0) + 1)
  }
  meta.packages = [...pkgs.entries()]
    .filter(([p]) => !/^(com\.google|org\.apache|kotlin|org\.jetbrains|javax|io\.netty|org\.slf4j|com\.mojang)/.test(p))
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([p]) => p)
  return meta
}

// ---------------- Кеш метаданных ----------------
// Ключ — имя без .disabled + размер + время изменения: переименование при
// включении/выключении не меняет mtime, поэтому мод не перечитывается.

type CachedMeta = Omit<ModMeta, 'file' | 'enabled'>
let cache: Map<string, CachedMeta> | null = null
let saveTimer: NodeJS.Timeout | null = null
const cacheFile = (): string => path.join(dirs.cache(), 'mods-meta-v1.json')

function metaCache(): Map<string, CachedMeta> {
  if (!cache) cache = new Map(Object.entries(readJson<Record<string, CachedMeta>>(cacheFile(), {})))
  return cache
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    const c = metaCache()
    // не храним вечно записи удалённых модов
    const entries = [...c.entries()].slice(-3000)
    fs.promises.writeFile(cacheFile(), JSON.stringify(Object.fromEntries(entries))).catch(() => undefined)
  }, 1500)
}

const keyOf = (file: string, st: fs.Stats): string => `${path.basename(file).replace(/\.disabled$/, '')}|${st.size}|${Math.round(st.mtimeMs)}`

async function cachedMeta(file: string): Promise<ModMeta> {
  const st = await fs.promises.stat(file)
  const base = path.basename(file)
  const key = keyOf(file, st)
  const hit = metaCache().get(key)
  if (hit) return { ...hit, packages: [...hit.packages], depends: [...hit.depends], loaders: [...hit.loaders], file: base, enabled: !base.endsWith('.disabled') }
  const meta = await readModMeta(file)
  const { file: _f, enabled: _e, ...rest } = meta
  metaCache().set(key, rest)
  scheduleSave()
  return meta
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  const worker = async (): Promise<void> => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

export function modsDir(instanceId: string): string {
  return ensureDir(path.join(gameDir(instanceId), 'mods'))
}

export async function listMods(instanceId: string, withPackages = false): Promise<ModMeta[]> {
  const dir = modsDir(instanceId)
  const files = (await fs.promises.readdir(dir)).filter((f) => /\.(jar|zip)(\.disabled)?$/i.test(f) && f !== 'aurora-helper.jar')
  const list = await mapLimit(files, 6, async (f) => {
    const m = await cachedMeta(path.join(dir, f)).catch(() => null)
    if (m && !withPackages) m.packages = []
    return m
  })
  return list.filter((m): m is ModMeta => !!m).sort((a, b) => a.name.localeCompare(b.name))
}

/** Переключает мод и возвращает его новое имя файла. */
export async function toggleMod(instanceId: string, file: string, enabled: boolean): Promise<string> {
  const dir = modsDir(instanceId)
  const plain = path.join(dir, path.basename(file).replace(/\.disabled$/, ''))
  const target = enabled ? plain : plain + '.disabled'
  // быстрые повторные клики могут прийти со старым именем файла — ищем любой из вариантов
  const cur = [plain, plain + '.disabled'].find((p) => p !== target && exists(p))
  if (cur) await fs.promises.rename(cur, target)
  return path.basename(target)
}

export async function deleteMod(instanceId: string, file: string): Promise<void> {
  await fs.promises.rm(path.join(modsDir(instanceId), path.basename(file)), { force: true })
}
