import fs from 'fs'
import path from 'path'
import type { Instance } from '@shared/types'
import { dirs } from './settings'
import { readJson, writeJson, exists, ensureDir, uid } from './util/store'
import { emit } from './events'

const META = 'aurora-instance.json'

export function instanceDir(id: string): string {
  return path.join(dirs.instances(), id)
}

export function gameDir(id: string): string {
  return ensureDir(path.join(instanceDir(id), '.minecraft'))
}

export function listInstances(): Instance[] {
  const root = dirs.instances()
  const out: Instance[] = []
  for (const name of fs.readdirSync(root)) {
    const meta = path.join(root, name, META)
    if (!exists(meta)) continue
    const inst = readJson<Instance | null>(meta, null)
    if (inst) out.push({ ...inst, id: name })
  }
  return out.sort((a, b) => (b.lastPlayed || b.createdAt) - (a.lastPlayed || a.createdAt))
}

export function getInstance(id: string): Instance {
  const inst = readJson<Instance | null>(path.join(instanceDir(id), META), null)
  if (!inst) throw new Error('Сборка не найдена')
  return { ...inst, id }
}

export function saveInstance(inst: Instance): Instance {
  writeJson(path.join(instanceDir(inst.id), META), inst)
  emit('instances:changed')
  return inst
}

function slug(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9а-яё_-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'instance'
  let id = base
  while (exists(instanceDir(id))) id = `${base}-${uid().slice(-4)}`
  return id
}

export function createInstance(data: Omit<Instance, 'id' | 'createdAt'>): Instance {
  const inst: Instance = { ...data, id: slug(data.name), createdAt: Date.now() }
  ensureDir(gameDir(inst.id))
  return saveInstance(inst)
}

export function updateInstance(id: string, patch: Partial<Instance>): Instance {
  const cur = getInstance(id)
  const next = { ...cur, ...patch, id }
  // смена версии/загрузчика — потребуется переустановка
  if (patch.mcVersion !== undefined || patch.loader !== undefined || patch.loaderVersion !== undefined) {
    if (patch.mcVersion !== cur.mcVersion || patch.loader !== cur.loader || patch.loaderVersion !== cur.loaderVersion) {
      next.versionId = undefined
    }
  }
  return saveInstance(next)
}

export function deleteInstance(id: string): void {
  fs.rmSync(instanceDir(id), { recursive: true, force: true })
  emit('instances:changed')
}

export function duplicateInstance(id: string): Instance {
  const src = getInstance(id)
  const copy = createInstance({ ...src, name: src.name + ' (копия)', lastPlayed: undefined, playTime: 0 })
  fs.cpSync(gameDir(id), gameDir(copy.id), { recursive: true })
  return copy
}
