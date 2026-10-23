import fs from 'fs'
import path from 'path'
import AdmZip from 'adm-zip'
import type { Instance, LoaderType } from '@shared/types'
import { dirs, getSettings } from '../settings'
import { downloadAll, downloadFile, type DownloadItem } from '../util/net'
import { safeJoin, ensureDir } from '../util/store'
import { withTask, withCancellableTask, type TaskHandle } from "../events"
import { createInstance, gameDir, deleteInstance, getInstance } from '../instances'
import { ensureInstalled } from '../minecraft/launch'
import { modrinthVersions, getModrinthVersion, getModrinthProject, type MrVersion } from './modrinth'
import { cfGet, cfPost, cfDownloadUrl, cfSha1, type CfFile } from './curseforge'

interface MrIndex {
  name: string
  versionId: string
  files: { path: string; hashes: { sha1: string }; downloads: string[]; fileSize: number; env?: { client?: string } }[]
  dependencies: Record<string, string>
}

interface CfManifest {
  name: string
  version?: string
  minecraft: { version: string; modLoaders: { id: string; primary: boolean }[] }
  files: { projectID: number; fileID: number; required: boolean }[]
  overrides?: string
}

function extractDir(zip: AdmZip, prefix: string, target: string): void {
  for (const e of zip.getEntries()) {
    if (!e.entryName.startsWith(prefix + '/') || e.isDirectory) continue
    const rel = e.entryName.slice(prefix.length + 1)
    if (!rel) continue
    const dst = safeJoin(target, rel)
    ensureDir(path.dirname(dst))
    fs.writeFileSync(dst, e.getData())
  }
}

function loaderFromMr(deps: Record<string, string>): { loader: LoaderType; version?: string } {
  if (deps['fabric-loader']) return { loader: 'fabric', version: deps['fabric-loader'] }
  if (deps['quilt-loader']) return { loader: 'quilt', version: deps['quilt-loader'] }
  if (deps['neoforge']) return { loader: 'neoforge', version: deps['neoforge'] }
  if (deps['forge']) return { loader: 'forge', version: deps['forge'] }
  return { loader: 'vanilla' }
}

async function installMrpack(file: string, task: TaskHandle, meta: Partial<Instance> = {}): Promise<Instance> {
  const zip = new AdmZip(file)
  const idx = JSON.parse(zip.readAsText('modrinth.index.json')) as MrIndex
  const { loader, version } = loaderFromMr(idx.dependencies)
  const inst = createInstance({
    name: meta.name || idx.name,
    mcVersion: idx.dependencies.minecraft,
    loader,
    loaderVersion: version,
    icon: meta.icon,
    source: meta.source || { type: 'file', name: idx.name }
  })
  try {
    const gdir = gameDir(inst.id)
    const items: DownloadItem[] = idx.files
      .filter((f) => f.env?.client !== 'unsupported')
      .map((f) => ({ url: f.downloads[0], mirrors: f.downloads.slice(1), path: safeJoin(gdir, f.path), sha1: f.hashes.sha1, size: f.fileSize }))
    await downloadAll(items, {
      concurrency: getSettings().concurrency,
      signal: task.signal,
      onProgress: (d, t) => task.update(0.05 + 0.4 * (t ? d / t : 1), `Моды и ресурсы: ${d}/${t}`)
    })
    extractDir(zip, 'overrides', gdir)
    extractDir(zip, 'client-overrides', gdir)
    task.detail('Установка Minecraft и загрузчика')
    await ensureInstalled(getInstance(inst.id), task)
    return getInstance(inst.id)
  } catch (e) {
    deleteInstance(inst.id)
    throw e
  }
}

async function installCfZip(file: string, task: TaskHandle, meta: Partial<Instance> = {}): Promise<Instance> {
  const zip = new AdmZip(file)
  const man = JSON.parse(zip.readAsText('manifest.json')) as CfManifest
  const primary = man.minecraft.modLoaders.find((l) => l.primary) || man.minecraft.modLoaders[0]
  let loader: LoaderType = 'vanilla'
  let loaderVersion: string | undefined
  if (primary) {
    const [name, ...rest] = primary.id.split('-')
    loader = (['forge', 'fabric', 'quilt', 'neoforge'].includes(name) ? name : 'forge') as LoaderType
    loaderVersion = rest.join('-')
    if (loader === 'neoforge' && man.minecraft.version === '1.20.1' && !loaderVersion.startsWith('1.20.1-')) loaderVersion = `1.20.1-${loaderVersion}`
  }
  const inst = createInstance({
    name: meta.name || man.name,
    mcVersion: man.minecraft.version,
    loader,
    loaderVersion,
    icon: meta.icon,
    source: meta.source || { type: 'file', name: man.name }
  })
  try {
    const gdir = gameDir(inst.id)
    const required = man.files.filter((f) => f.required !== false)
    task.detail('Получение списка файлов CurseForge')
    const filesRes = await cfPost<{ data: CfFile[] }>('/mods/files', { fileIds: required.map((f) => f.fileID) })
    const modsRes = await cfPost<{ data: { id: number; classId: number }[] }>('/mods', { modIds: [...new Set(required.map((f) => f.projectID))] })
    const classOf = new Map(modsRes.data.map((m) => [m.id, m.classId]))
    const folder = (cls?: number): string => (cls === 12 ? 'resourcepacks' : cls === 6552 ? 'shaderpacks' : cls === 17 ? 'saves' : 'mods')
    const items: DownloadItem[] = filesRes.data.map((f) => ({
      url: cfDownloadUrl(f),
      path: safeJoin(gdir, path.join(folder(classOf.get(f.modId)), f.fileName)),
      sha1: cfSha1(f),
      size: f.fileLength
    }))
    await downloadAll(items, {
      concurrency: getSettings().concurrency,
      signal: task.signal,
      onProgress: (d, t) => task.update(0.05 + 0.4 * (t ? d / t : 1), `Моды: ${d}/${t}`)
    })
    extractDir(zip, man.overrides || 'overrides', gdir)
    task.detail('Установка Minecraft и загрузчика')
    await ensureInstalled(getInstance(inst.id), task)
    return getInstance(inst.id)
  } catch (e) {
    deleteInstance(inst.id)
    throw e
  }
}

/** Импорт сборки из файла: .mrpack (Modrinth) или .zip (CurseForge / архив Aurora/Prism). */
export function importPackFile(file: string): Promise<Instance> {
  return withCancellableTask(`Импорт ${path.basename(file)}`, (t) => {
    const zip = new AdmZip(file)
    if (zip.getEntry('modrinth.index.json')) return installMrpack(file, t)
    if (zip.getEntry('manifest.json')) return installCfZip(file, t)
    throw new Error('Неизвестный формат: нужен .mrpack (Modrinth) или .zip с manifest.json (CurseForge)')
  })
}

export function installModrinthPack(projectId: string, versionId?: string): Promise<Instance> {
  return withCancellableTask("Установка сборки Modrinth", async (t) => {
    const project = await getModrinthProject(projectId)
    t.detail(project.title)
    const v: MrVersion = versionId ? await getModrinthVersion(versionId) : (await modrinthVersions(projectId))[0]
    if (!v) throw new Error('У сборки нет версий')
    const f = v.files.find((x) => x.primary) || v.files[0]
    const file = path.join(dirs.cache(), 'packs', f.filename)
    await downloadFile({ url: f.url, path: file, sha1: f.hashes.sha1 }, undefined, 3, t.signal)
    const inst = await installMrpack(file, t, {
      name: project.title,
      icon: project.icon_url,
      source: { type: 'modrinth', projectId, versionId: v.id, name: project.title }
    })
    fs.rmSync(file, { force: true })
    return inst
  })
}

export function installCurseforgePack(projectId: string, fileId?: string): Promise<Instance> {
  return withCancellableTask("Установка сборки CurseForge", async (t) => {
    const mod = (await cfGet<{ data: { name: string; logo?: { thumbnailUrl: string }; latestFiles: CfFile[] } }>(`/mods/${projectId}`)).data
    t.detail(mod.name)
    const f = fileId
      ? (await cfGet<{ data: CfFile }>(`/mods/${projectId}/files/${fileId}`)).data
      : [...mod.latestFiles].sort((a, b) => +new Date(b.fileDate) - +new Date(a.fileDate))[0]
    const file = path.join(dirs.cache(), 'packs', f.fileName)
    await downloadFile({ url: cfDownloadUrl(f), path: file, sha1: cfSha1(f) }, undefined, 3, t.signal)
    const inst = await installCfZip(file, t, {
      name: mod.name,
      icon: mod.logo?.thumbnailUrl,
      source: { type: 'curseforge', projectId, versionId: String(f.id), name: mod.name }
    })
    fs.rmSync(file, { force: true })
    return inst
  })
}

/** Сборка по прямой ссылке (например, .mrpack из релизов GitHub). */
export function installPackFromUrl(url: string, name?: string): Promise<Instance> {
  return withCancellableTask(`Скачивание ${name || "сборки"}`, async (t) => {
    const fname = decodeURIComponent(new URL(url).pathname.split('/').pop() || 'pack.mrpack')
    const file = path.join(dirs.cache(), 'packs', fname)
    let got = 0
    await downloadFile({ url, path: file }, (n) => { got += n; t.update(0.02, `Скачано ${(got / 1048576).toFixed(1)} МБ`) }, 3, t.signal)
    const zip = new AdmZip(file)
    const meta: Partial<Instance> = { name, source: { type: 'github', name } }
    const inst = zip.getEntry('modrinth.index.json') ? await installMrpack(file, t, meta) : await installCfZip(file, t, meta)
    fs.rmSync(file, { force: true })
    return inst
  })
}

// ---------------- Установка отдельных модов ----------------

const TYPE_DIR: Record<string, string> = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks' }

export function installModrinthProject(
  instanceId: string,
  projectId: string,
  type: 'mod' | 'resourcepack' | 'shader',
  versionId?: string,
  loaderOverride?: string
): Promise<string[]> {
  const inst = getInstance(instanceId)
  return withCancellableTask('Установка из Modrinth', async (t) => {
    const installed: string[] = []
    const seen = new Set<string>()
    const install = async (pid: string, vid?: string): Promise<void> => {
      if (seen.has(pid)) return
      seen.add(pid)
      const loader = type === 'mod' ? loaderOverride || inst.loader : undefined
      const v = vid ? await getModrinthVersion(vid) : (await modrinthVersions(pid, inst.mcVersion, loader))[0]
      if (!v) throw new Error(`Нет версии под Minecraft ${inst.mcVersion}${loader ? ' / ' + loader : ''}`)
      const f = v.files.find((x) => x.primary) || v.files[0]
      const dst = safeJoin(gameDir(instanceId), path.join(TYPE_DIR[type], f.filename))
      t.detail(f.filename)
      await downloadFile({ url: f.url, path: dst, sha1: f.hashes.sha1 }, undefined, 3, t.signal)
      installed.push(f.filename)
      if (type === 'mod') {
        for (const d of v.dependencies.filter((d) => d.dependency_type === 'required' && d.project_id)) {
          await install(d.project_id!, d.version_id).catch(() => undefined)
        }
      }
    }
    await install(projectId, versionId)
    return installed
  })
}

export function installCurseforgeProject(instanceId: string, projectId: string, type: 'mod' | 'resourcepack' | 'shader', fileId?: string): Promise<string[]> {
  const inst = getInstance(instanceId)
  return withCancellableTask('Установка из CurseForge', async (t) => {
    let f: CfFile
    if (fileId) f = (await cfGet<{ data: CfFile }>(`/mods/${projectId}/files/${fileId}`)).data
    else {
      const p = new URLSearchParams({ gameVersion: inst.mcVersion, pageSize: '1' })
      const ids: Record<string, number> = { forge: 1, fabric: 4, quilt: 5, neoforge: 6 }
      if (type === 'mod' && ids[inst.loader]) p.set('modLoaderType', String(ids[inst.loader]))
      const list = (await cfGet<{ data: CfFile[] }>(`/mods/${projectId}/files?${p}`)).data
      if (!list[0]) throw new Error(`Нет файла под Minecraft ${inst.mcVersion}`)
      f = list[0]
    }
    t.detail(f.fileName)
    await downloadFile({ url: cfDownloadUrl(f), path: safeJoin(gameDir(instanceId), path.join(TYPE_DIR[type], f.fileName)), sha1: cfSha1(f) }, undefined, 3, t.signal)
    return [f.fileName]
  })
}

/** Экспорт сборки в .mrpack-совместимый zip (моды кладутся целиком в overrides). */
export function exportInstance(instanceId: string, target: string): Promise<void> {
  const inst = getInstance(instanceId)
  return withTask(`Экспорт «${inst.name}»`, async () => {
    const zip = new AdmZip()
    const deps: Record<string, string> = { minecraft: inst.mcVersion }
    const key = { fabric: 'fabric-loader', quilt: 'quilt-loader', forge: 'forge', neoforge: 'neoforge', vanilla: '' }[inst.loader]
    if (key && inst.loaderVersion) deps[key] = inst.loaderVersion
    zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify({ formatVersion: 1, game: 'minecraft', versionId: '1.0.0', name: inst.name, files: [], dependencies: deps }, null, 2)))
    const gdir = gameDir(instanceId)
    for (const d of ['mods', 'config', 'resourcepacks', 'shaderpacks', 'kubejs', 'defaultconfigs', 'scripts']) {
      const p = path.join(gdir, d)
      if (fs.existsSync(p)) zip.addLocalFolder(p, `overrides/${d}`)
    }
    for (const f of ['options.txt', 'servers.dat']) {
      const p = path.join(gdir, f)
      if (fs.existsSync(p)) zip.addLocalFile(p, 'overrides')
    }
    await zip.writeZipPromise(target)
  })
}
