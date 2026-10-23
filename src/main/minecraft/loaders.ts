import fs from 'fs'
import path from 'path'
import { spawn } from 'child_process'
import AdmZip from 'adm-zip'
import type { LoaderType, LoaderVersion } from '@shared/types'
import { dirs, getSettings } from '../settings'
import { fetchJson, fetchText, downloadFile, downloadAll, type DownloadItem } from '../util/net'
import { writeJson, exists, ensureDir } from '../util/store'
import type { TaskHandle } from '../events'
import { installVersion, clientJarPath, libraryPath } from './install'
import { mavenPath, versionJsonPath, type VersionJson, type Library } from './versions'

const FABRIC = 'https://meta.fabricmc.net/v2'
const QUILT = 'https://meta.quiltmc.org/v3'
const FORGE_MAVEN = 'https://maven.minecraftforge.net/net/minecraftforge/forge'
const NEO_MAVEN = 'https://maven.neoforged.net/releases'

export async function listLoaderVersions(loader: LoaderType, mc: string): Promise<LoaderVersion[]> {
  switch (loader) {
    case 'fabric': {
      const list = await fetchJson<{ loader: { version: string; stable: boolean } }[]>(`${FABRIC}/versions/loader/${mc}`)
      return list.map((l) => ({ version: l.loader.version, stable: l.loader.stable }))
    }
    case 'quilt': {
      const list = await fetchJson<{ loader: { version: string } }[]>(`${QUILT}/versions/loader/${mc}`)
      return list.map((l) => ({ version: l.loader.version, stable: !/beta|alpha|pre|rc/.test(l.loader.version) }))
    }
    case 'forge': {
      const xml = await fetchText(`${FORGE_MAVEN}/maven-metadata.xml`)
      const versions = [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map((m) => m[1])
      let promos: Record<string, string> = {}
      try {
        promos = (await fetchJson<{ promos: Record<string, string> }>(
          'https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json'
        )).promos
      } catch {
        /* необязательно */
      }
      const rec = promos[`${mc}-recommended`]
      return versions
        .filter((v) => v.startsWith(mc + '-'))
        .map((v) => v.slice(mc.length + 1))
        .reverse()
        .map((v) => ({ version: v, stable: v === rec || v === promos[`${mc}-latest`] }))
    }
    case 'neoforge': {
      if (mc === '1.20.1') {
        const r = await fetchJson<{ versions: string[] }>('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/forge')
        return r.versions.filter((v) => v.startsWith('1.20.1-')).reverse().map((v) => ({ version: v, stable: true }))
      }
      const r = await fetchJson<{ versions: string[] }>('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge')
      const prefix = neoPrefix(mc)
      return r.versions
        .filter((v) => v.startsWith(prefix))
        .reverse()
        .map((v) => ({ version: v, stable: !v.includes('beta') }))
    }
    default:
      return []
  }
}

function neoPrefix(mc: string): string {
  if (mc.startsWith('1.')) {
    const rest = mc.slice(2).split('.')
    return `${rest[0]}.${rest[1] || '0'}.`
  }
  return mc + '.'
}

/** Устанавливает ваниллу + загрузчик. Возвращает id итоговой версии. */
export async function installLoader(
  loader: LoaderType,
  mc: string,
  loaderVersion: string | undefined,
  javaPath: () => Promise<string>,
  task?: TaskHandle
): Promise<string> {
  if (loader === 'vanilla') return mc
  let ver = loaderVersion
  if (!ver) {
    const list = await listLoaderVersions(loader, mc)
    ver = (list.find((l) => l.stable) || list[0])?.version
    if (!ver) throw new Error(`Для ${mc} нет версий ${loader}`)
  }
  if (loader === 'neoforge' && mc === '1.20.1' && !ver.startsWith('1.20.1-')) ver = `1.20.1-${ver}`
  task?.detail(`Установка ${loader} ${ver}`)
  if (loader === 'fabric' || loader === 'quilt') {
    const base = loader === 'fabric' ? FABRIC : QUILT
    const profile = await fetchJson<VersionJson>(`${base}/versions/loader/${mc}/${ver}/profile/json`)
    writeJson(versionJsonPath(profile.id), profile)
    return profile.id
  }
  const installerUrl =
    loader === 'forge'
      ? `${FORGE_MAVEN}/${mc}-${ver}/forge-${mc}-${ver}-installer.jar`
      : ver.startsWith('1.20.1-')
        ? `${NEO_MAVEN}/net/neoforged/forge/${ver}/forge-${ver}-installer.jar`
        : `${NEO_MAVEN}/net/neoforged/neoforge/${ver}/neoforge-${ver}-installer.jar`
  const installer = path.join(dirs.cache(), 'installers', path.basename(installerUrl))
  if (!exists(installer)) await downloadFile({ url: installerUrl, path: installer })
  return installForgeLike(installer, mc, javaPath, task)
}

interface InstallProfile {
  spec?: number
  version?: string
  json?: string
  minecraft?: string
  libraries?: Library[]
  data?: Record<string, { client: string; server: string }>
  processors?: { jar: string; classpath: string[]; args: string[]; sides?: string[]; outputs?: Record<string, string> }[]
  // старый формат (до 1.12.2)
  install?: { path: string; filePath: string; target: string }
  versionInfo?: VersionJson
}

/** Установка Forge/NeoForge без GUI: распаковываем профиль и сами выполняем процессоры установщика. */
async function installForgeLike(installer: string, mc: string, javaPath: () => Promise<string>, task?: TaskHandle): Promise<string> {
  const zip = new AdmZip(installer)
  const profileEntry = zip.getEntry('install_profile.json')
  if (!profileEntry) throw new Error('Повреждённый установщик: нет install_profile.json')
  const profile = JSON.parse(zip.readAsText(profileEntry)) as InstallProfile

  // Старый Forge (1.5 – 1.12.2 ранние сборки)
  if (profile.versionInfo && profile.install) {
    const v = profile.versionInfo
    writeJson(versionJsonPath(v.id), v)
    const universal = zip.getEntry(profile.install.filePath)
    if (universal) {
      const dst = libraryPath(mavenPath(profile.install.path))
      ensureDir(path.dirname(dst))
      fs.writeFileSync(dst, universal.getData())
    }
    await installVersion(v.id, task)
    return v.id
  }

  const vEntry = zip.getEntry((profile.json || '/version.json').replace(/^\//, ''))
  if (!vEntry) throw new Error('В установщике нет version.json')
  const version = JSON.parse(zip.readAsText(vEntry)) as VersionJson
  writeJson(versionJsonPath(version.id), version)

  // Нужна ванилла (client.jar), процессоры её патчат
  await installVersion(mc, task)

  // Библиотеки: из папки maven/ установщика или из сети
  const items: DownloadItem[] = []
  for (const lib of [...(profile.libraries || []), ...(version.libraries || [])]) {
    const rel = lib.downloads?.artifact?.path || mavenPath(lib.name)
    const dst = libraryPath(rel)
    const embedded = zip.getEntry('maven/' + rel)
    if (embedded) {
      if (!exists(dst)) {
        ensureDir(path.dirname(dst))
        fs.writeFileSync(dst, embedded.getData())
      }
      continue
    }
    const url = lib.downloads?.artifact?.url
    if (url) items.push({ url, path: dst, sha1: lib.downloads?.artifact?.sha1, size: lib.downloads?.artifact?.size })
  }
  await downloadAll(items, {
    concurrency: getSettings().concurrency,
    onProgress: (d, t) => task?.update(0.5 + 0.2 * (t ? d / t : 1), `Библиотеки загрузчика: ${d}/${t}`)
  })

  // Процессоры
  const tmp = ensureDir(path.join(dirs.cache(), 'forge-tmp', path.basename(installer, '.jar')))
  const data: Record<string, string> = {
    SIDE: 'client',
    MINECRAFT_JAR: clientJarPath(mc),
    MINECRAFT_VERSION: mc,
    ROOT: dirs.root(),
    INSTALLER: installer,
    LIBRARY_DIR: dirs.libraries()
  }
  for (const [k, v] of Object.entries(profile.data || {})) {
    const val = v.client
    if (val.startsWith('[') && val.endsWith(']')) data[k] = libraryPath(mavenPath(val.slice(1, -1)))
    else if (val.startsWith("'") && val.endsWith("'")) data[k] = val.slice(1, -1)
    else if (val.startsWith('/')) {
      const e = zip.getEntry(val.slice(1))
      const out = path.join(tmp, ...val.slice(1).split('/'))
      if (e) {
        ensureDir(path.dirname(out))
        fs.writeFileSync(out, e.getData())
      }
      data[k] = out
    } else data[k] = val
  }
  const resolveArg = (a: string): string => {
    if (a.startsWith('[') && a.endsWith(']')) return libraryPath(mavenPath(a.slice(1, -1)))
    return a.replace(/\{([A-Z_]+)\}/g, (_m, key: string) => data[key] ?? `{${key}}`)
  }

  const procs = (profile.processors || []).filter((p) => !p.sides || p.sides.includes('client'))
  const java = procs.length ? await javaPath() : ''
  for (let i = 0; i < procs.length; i++) {
    const p = procs[i]
    task?.update(0.7 + 0.28 * (i / procs.length), `Патчинг Minecraft (${i + 1}/${procs.length})`)
    const jar = libraryPath(mavenPath(p.jar))
    const mainClass = readMainClass(jar)
    if (!mainClass) throw new Error(`Не найден Main-Class в ${p.jar}`)
    const cp = [jar, ...p.classpath.map((c) => libraryPath(mavenPath(c)))].join(path.delimiter)
    const args = p.args.map(resolveArg)
    await runJava(java, ['-cp', cp, mainClass, ...args])
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  await installVersion(version.id, task)
  return version.id
}

function readMainClass(jar: string): string | null {
  try {
    const mf = new AdmZip(jar).readAsText('META-INF/MANIFEST.MF')
    return /^Main-Class:\s*(\S+)/m.exec(mf)?.[1] || null
  } catch {
    return null
  }
}

function runJava(java: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(java, args, { cwd: dirs.root(), windowsHide: true })
    let out = ''
    proc.stdout.on('data', (d) => (out = (out + d).slice(-4000)))
    proc.stderr.on('data', (d) => (out = (out + d).slice(-4000)))
    proc.on('error', reject)
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Процессор установщика завершился с кодом ${code}:\n${out}`))))
  })
}

export function loaderLabel(l: LoaderType): string {
  return { vanilla: 'Vanilla', fabric: 'Fabric', quilt: 'Quilt', forge: 'Forge', neoforge: 'NeoForge' }[l]
}
