import fs from 'fs'
import path from 'path'
import AdmZip from 'adm-zip'
import type { ModInfo } from '@shared/types'
import { gameDir } from './instances'
import { ensureDir } from './util/store'

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

/** Читает метаданные мода: fabric.mod.json / quilt.mod.json / mods.toml / mcmod.info */
export function readModMeta(file: string): ModMeta {
  const st = fs.statSync(file)
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
  let zip: AdmZip
  try {
    zip = new AdmZip(file)
  } catch {
    return meta
  }
  const read = (n: string): string | null => {
    const e = zip.getEntry(n)
    return e ? zip.readAsText(e) : null
  }
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
  for (const e of zip.getEntries()) {
    if (!e.entryName.endsWith('.class')) continue
    const parts = e.entryName.split('/')
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

export function modsDir(instanceId: string): string {
  return ensureDir(path.join(gameDir(instanceId), 'mods'))
}

export function listMods(instanceId: string, withPackages = false): ModMeta[] {
  const dir = modsDir(instanceId)
  return fs
    .readdirSync(dir)
    .filter((f) => /\.(jar|zip)(\.disabled)?$/i.test(f) && f !== 'aurora-helper.jar')
    .map((f) => {
      const m = readModMeta(path.join(dir, f))
      if (!withPackages) m.packages = []
      return m
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function toggleMod(instanceId: string, file: string, enabled: boolean): void {
  const dir = modsDir(instanceId)
  const cur = path.join(dir, path.basename(file))
  const target = enabled ? cur.replace(/\.disabled$/, '') : cur.endsWith('.disabled') ? cur : cur + '.disabled'
  if (cur !== target) fs.renameSync(cur, target)
}

export function deleteMod(instanceId: string, file: string): void {
  fs.rmSync(path.join(modsDir(instanceId), path.basename(file)), { force: true })
}
