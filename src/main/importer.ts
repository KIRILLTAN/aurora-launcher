import fs from 'fs'
import path from 'path'
import yauzl from 'yauzl'
import type { ImportPreview, Instance, LoaderType } from '@shared/types'
import { createInstance, deleteInstance, gameDir, getInstance, saveInstance } from './instances'
import { withCancellableTask, type TaskHandle } from './events'
import { ensureDir, exists, safeJoin } from './util/store'
import { CancelledError } from './util/cancel'
import { ensureInstalled } from './minecraft/launch'
import { importPackFile } from './catalog/modpacks'

/*
 * Импорт «живых» сборок, которыми уже кто-то играл:
 * экспорт Prism Launcher / MultiMC (instance.cfg + mmc-pack.json),
 * CurseForge App (minecraftinstance.json), ATLauncher (instance.json),
 * GDLauncher и обычные папки/архивы .minecraft (TLauncher и т.п.).
 * Переносится всё: моды, конфиги, миры, ресурспаки, шейдеры, настройки.
 */

/** Папки, которые не переносим: лаунчер скачает их сам или это мусор. */
const SKIP_DIRS = ['logs', 'crash-reports', '.cache', 'debug', '.mixin.out', 'versions', 'libraries', 'assets', 'runtime', 'natives', 'webcache', 'webcache2', '.fabric', 'downloads']
const SKIP_FILES = ['MixinRuntimeAgent.jar', 'launcher_profiles.json', 'launcher_accounts.json', 'usercache.json', 'usernamecache.json', 'TlauncherProfiles.json']
/** Тяжёлые папки, которые даже не сканируем при импорте папки. */
const HEAVY_DIRS = ["assets", "libraries", "runtime", "webcache", "webcache2", ".cache", "node_modules"]

interface Entry {
  name: string
  size: number
}

interface Source {
  entries: Entry[]
  readText(name: string): Promise<string | null>
  extract(map: (name: string) => string | null, onProgress: (done: number, total: number) => void, signal: AbortSignal): Promise<void>
  close(): void
}

// ---------------- Источники: zip и папка ----------------

function openZip(file: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => (err || !zip ? reject(err || new Error('Не удалось открыть архив')) : resolve(zip)))
  )
}

async function zipSource(file: string): Promise<Source> {
  const zip = await openZip(file)
  const all: (Entry & { raw: yauzl.Entry })[] = await new Promise((resolve, reject) => {
    const list: (Entry & { raw: yauzl.Entry })[] = []
    zip.on('entry', (e: yauzl.Entry) => {
      if (!e.fileName.endsWith('/')) list.push({ name: e.fileName.replace(/\\/g, '/'), size: e.uncompressedSize, raw: e })
      zip.readEntry()
    })
    zip.on('end', () => resolve(list))
    zip.on('error', reject)
    zip.readEntry()
  })
  const stream = (e: yauzl.Entry): Promise<NodeJS.ReadableStream> =>
    new Promise((resolve, reject) => zip.openReadStream(e, (err, s) => (err || !s ? reject(err) : resolve(s))))
  return {
    entries: all,
    close: () => zip.close(),
    async readText(name) {
      const e = all.find((x) => x.name === name)
      if (!e) return null
      const s = await stream(e.raw)
      const chunks: Buffer[] = []
      for await (const c of s as AsyncIterable<Buffer>) chunks.push(c)
      return Buffer.concat(chunks).toString('utf8')
    },
    async extract(map, onProgress, signal) {
      const total = all.reduce((s, e) => s + e.size, 0) || 1
      let done = 0
      try {
        for (const e of all) {
          if (signal.aborted) throw new CancelledError()
          const dst = map(e.name)
          if (dst) {
            ensureDir(path.dirname(dst))
            const s = await stream(e.raw)
            await new Promise<void>((resolve, reject) => {
              const out = fs.createWriteStream(dst)
              s.on('error', reject)
              out.on('error', reject)
              out.on('finish', () => resolve())
              s.pipe(out)
            })
          }
          done += e.size
          onProgress(done, total)
        }
      } finally {
        zip.close()
      }
    }
  }
}

function dirSource(root: string): Source {
  const entries: Entry[] = []
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name)
      const rel = path.relative(root, p).split(path.sep).join('/')
      if (e.isDirectory()) {
        if (!HEAVY_DIRS.includes(e.name)) walk(p)
      } else entries.push({ name: rel, size: fs.statSync(p).size })
    }
  }
  walk(root)
  return {
    entries,
    close: () => undefined,
    async readText(name) {
      const p = path.join(root, name)
      return exists(p) ? fs.readFileSync(p, 'utf8') : null
    },
    async extract(map, onProgress, signal) {
      const total = entries.reduce((s, e) => s + e.size, 0) || 1
      let done = 0
      for (const e of entries) {
        if (signal.aborted) throw new CancelledError()
        const dst = map(e.name)
        if (dst) {
          ensureDir(path.dirname(dst))
          await fs.promises.copyFile(path.join(root, e.name), dst)
        }
        done += e.size
        onProgress(done, total)
      }
    }
  }
}

async function openSource(p: string): Promise<Source> {
  return fs.statSync(p).isDirectory() ? dirSource(p) : zipSource(p)
}

// ---------------- Определение формата ----------------

interface Detected extends ImportPreview {
  gameRoot: string
}

function shallowest(entries: Entry[], file: string): string | null {
  const hits = entries.filter((e) => e.name === file || e.name.endsWith('/' + file)).map((e) => e.name.slice(0, e.name.length - file.length))
  if (!hits.length) return null
  return hits.sort((a, b) => a.split('/').length - b.split('/').length)[0]
}

function parseCfg(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^([^=#[]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1].trim()] = m[2].trim()
  }
  return out
}

/** Загрузчик и версии по библиотекам из json версии (TLauncher, официальный лаунчер, ATLauncher). */
function fromVersionJson(j: { id?: string; inheritsFrom?: string; libraries?: { name: string }[] }): { mc?: string; loader: LoaderType; loaderVersion?: string } {
  const libs = (j.libraries || []).map((l) => l.name)
  const find = (re: RegExp): string | undefined => libs.map((n) => re.exec(n)?.[1]).find(Boolean)
  const neo = find(/^net\.neoforged:(?:neoforge|forge):([^:]+)/)
  if (neo) return { mc: j.inheritsFrom, loader: 'neoforge', loaderVersion: neo }
  const forge = find(/^net\.minecraftforge:(?:forge|fmlloader):([^:]+)/)
  if (forge) {
    const m = /^([\d.]+)-([\d.]+)/.exec(forge)
    return { mc: j.inheritsFrom || m?.[1], loader: 'forge', loaderVersion: m?.[2] || forge }
  }
  const fabric = find(/^net\.fabricmc:fabric-loader:([^:]+)/)
  if (fabric) return { mc: j.inheritsFrom || find(/^net\.fabricmc:intermediary:([^:]+)/), loader: 'fabric', loaderVersion: fabric }
  const quilt = find(/^org\.quiltmc:quilt-loader:([^:]+)/)
  if (quilt) return { mc: j.inheritsFrom || find(/^net\.fabricmc:intermediary:([^:]+)/), loader: 'quilt', loaderVersion: quilt }
  return { mc: j.inheritsFrom || j.id, loader: 'vanilla' }
}

function parseLoaderString(s: string, mc?: string): { loader: LoaderType; loaderVersion?: string } {
  const m = /^(neoforge|forge|fabric|quilt)-(.+)$/i.exec(s.trim())
  if (!m) return { loader: 'vanilla' }
  const loader = m[1].toLowerCase() as LoaderType
  let ver = m[2]
  if (mc && ver.startsWith(mc + '-')) ver = ver.slice(mc.length + 1)
  if (mc && ver.endsWith('-' + mc)) ver = ver.slice(0, -(mc.length + 1))
  return { loader, loaderVersion: ver }
}

function stats(entries: Entry[], root: string): Pick<ImportPreview, 'mods' | 'worlds' | 'sizeMb'> {
  const inRoot = entries.filter((e) => e.name.startsWith(root))
  const rel = inRoot.map((e) => e.name.slice(root.length))
  return {
    mods: rel.filter((n) => /^mods\/[^/]+\.jar$/i.test(n)).length,
    worlds: new Set(rel.filter((n) => /^saves\/[^/]+\/level\.dat$/.test(n)).map((n) => n.split('/')[1])).size,
    sizeMb: Math.round(inRoot.reduce((s, e) => s + e.size, 0) / 1048576)
  }
}

async function detect(file: string, src: Source): Promise<Detected | 'mrpack' | 'cfpack'> {
  const E = src.entries
  const baseName = path.basename(file).replace(/\.(zip|mrpack)$/i, '')

  if (shallowest(E, 'modrinth.index.json') === '') return 'mrpack'
  const manifestAt = shallowest(E, 'manifest.json')
  if (manifestAt === '') {
    const m = JSON.parse((await src.readText('manifest.json')) || '{}')
    if (m.minecraft?.version) return 'cfpack'
  }

  // Prism Launcher / MultiMC
  const mmc = shallowest(E, 'mmc-pack.json')
  if (mmc !== null) {
    const pack = JSON.parse((await src.readText(mmc + 'mmc-pack.json')) || '{}') as { components?: { uid: string; version: string }[] }
    const cfg = parseCfg((await src.readText(mmc + 'instance.cfg')) || '')
    const comp = (uid: string): string | undefined => pack.components?.find((c) => c.uid === uid)?.version
    const mc = comp('net.minecraft')
    let loader: LoaderType = 'vanilla'
    let loaderVersion: string | undefined
    for (const [uid, l] of [['net.neoforged', 'neoforge'], ['net.minecraftforge', 'forge'], ['net.fabricmc.fabric-loader', 'fabric'], ['org.quiltmc.quilt-loader', 'quilt']] as const) {
      const v = comp(uid)
      if (v) {
        loader = l
        loaderVersion = v
        break
      }
    }
    const root = E.some((e) => e.name.startsWith(mmc + '.minecraft/')) ? mmc + '.minecraft/' : mmc + 'minecraft/'
    const mem = parseInt(cfg['MaxMemAlloc'] || '')
    return {
      file,
      format: 'prism',
      formatLabel: 'Prism Launcher / MultiMC',
      name: cfg['name'] || baseName,
      mcVersion: mc,
      loader,
      loaderVersion,
      playTime: parseInt(cfg['totalTimePlayed'] || '0') || 0,
      memoryMax: cfg['OverrideMemory'] === 'true' && mem ? mem : undefined,
      jvmArgs: cfg['OverrideJavaArgs'] === 'true' ? cfg['JvmArgs'] : undefined,
      gameRoot: root,
      ...stats(E, root)
    }
  }

  // CurseForge App
  const cfApp = shallowest(E, 'minecraftinstance.json')
  if (cfApp !== null) {
    const j = JSON.parse((await src.readText(cfApp + 'minecraftinstance.json')) || '{}') as {
      name?: string
      gameVersion?: string
      baseModLoader?: { name?: string; minecraftVersion?: string }
      allocatedMemory?: number
    }
    const mc = j.gameVersion || j.baseModLoader?.minecraftVersion
    const l = parseLoaderString(j.baseModLoader?.name || '', mc)
    return { file, format: 'curseforge-app', formatLabel: 'CurseForge App', name: j.name || baseName, mcVersion: mc, ...l, gameRoot: cfApp, ...stats(E, cfApp) }
  }

  // ATLauncher
  const atl = shallowest(E, 'instance.json')
  if (atl !== null) {
    const j = JSON.parse((await src.readText(atl + 'instance.json')) || '{}') as {
      id?: string
      inheritsFrom?: string
      libraries?: { name: string }[]
      launcher?: { name?: string; loaderVersion?: { type?: string; version?: string } }
    }
    if (j.launcher) {
      const lv = j.launcher.loaderVersion
      const fromLibs = fromVersionJson(j)
      const loader = (lv?.type?.toLowerCase() as LoaderType) || fromLibs.loader
      return {
        file,
        format: 'atlauncher',
        formatLabel: 'ATLauncher',
        name: j.launcher.name || baseName,
        mcVersion: fromLibs.mc || j.id,
        loader: ['fabric', 'forge', 'neoforge', 'quilt'].includes(loader) ? loader : fromLibs.loader,
        loaderVersion: lv?.version || fromLibs.loaderVersion,
        gameRoot: atl,
        ...stats(E, atl)
      }
    }
  }

  // Обычная папка .minecraft (TLauncher, официальный лаунчер, GDLauncher, ручной архив)
  const markers = E.filter((e) => /(^|\/)(mods\/[^/]+\.jar|options\.txt|saves\/[^/]+\/level\.dat|config\/[^/]+)$/.test(e.name))
  if (!markers.length) throw new Error('В архиве не найдена сборка Minecraft: нет папок mods, saves, config или файла options.txt')
  const roots = markers.map((e) => {
    const m = /^(.*?)(mods\/|options\.txt|saves\/|config\/)/.exec(e.name)
    return m ? m[1] : ''
  })
  const root = roots.sort((a, b) => a.split('/').length - b.split('/').length)[0]
  let mcVersion: string | undefined
  let loader: LoaderType = 'vanilla'
  let loaderVersion: string | undefined
  const versionJsons = E.filter((e) => e.name.startsWith(root + 'versions/') && /versions\/([^/]+)\/\1\.json$/.test(e.name))
  for (const v of versionJsons) {
    try {
      const d = fromVersionJson(JSON.parse((await src.readText(v.name)) || '{}'))
      if (d.loader !== 'vanilla' || !mcVersion) {
        mcVersion = d.mc
        loader = d.loader
        loaderVersion = d.loaderVersion
      }
    } catch {
      /* битый json */
    }
  }
  const gdl = await src.readText(root + 'config.json').catch(() => null)
  if (!mcVersion && gdl) {
    try {
      const j = JSON.parse(gdl) as { loader?: { mcVersion?: string; loaderType?: string; loaderVersion?: string } }
      if (j.loader?.mcVersion) {
        mcVersion = j.loader.mcVersion
        loader = (j.loader.loaderType as LoaderType) || 'vanilla'
        loaderVersion = j.loader.loaderVersion
      }
    } catch {
      /* не GDLauncher */
    }
  }
  return {
    file,
    format: 'minecraft',
    formatLabel: versionJsons.length ? 'Папка .minecraft (TLauncher / официальный лаунчер)' : 'Папка .minecraft',
    name: baseName,
    mcVersion,
    loader,
    loaderVersion,
    gameRoot: root,
    ...stats(E, root)
  }
}

// ---------------- API ----------------

export async function inspectImport(file: string): Promise<ImportPreview> {
  const src = await openSource(file)
  const d = await detect(file, src).finally(() => src.close())
  if (d === "mrpack") return { file, format: 'mrpack', formatLabel: 'Modrinth (.mrpack)', name: path.basename(file), loader: 'vanilla', mods: 0, worlds: 0, sizeMb: 0 }
  if (d === 'cfpack') return { file, format: 'curseforge-pack', formatLabel: 'Модпак CurseForge (.zip)', name: path.basename(file), loader: 'vanilla', mods: 0, worlds: 0, sizeMb: 0 }
  const { gameRoot: _r, ...preview } = d
  return preview
}

export interface ImportOptions {
  name: string
  mcVersion: string
  loader: LoaderType
  loaderVersion?: string
}

export async function importInstance(file: string, opts?: ImportOptions): Promise<Instance> {
  const src = await openSource(file)
  const d = await detect(file, src)
  if (d === "mrpack" || d === "cfpack") {
    src.close()
    return importPackFile(file)
  }
  const mcVersion = opts?.mcVersion || d.mcVersion
  if (!mcVersion) {
    src.close()
    throw new Error('Не удалось определить версию Minecraft — выберите её вручную')
  }
  return withCancellableTask(`Импорт «${opts?.name || d.name}»`, async (t: TaskHandle) => {
    const inst = createInstance({
      name: opts?.name || d.name,
      mcVersion,
      loader: opts?.loader || d.loader,
      loaderVersion: opts ? opts.loaderVersion : d.loaderVersion,
      memoryMax: d.memoryMax,
      jvmArgs: d.jvmArgs,
      playTime: d.playTime,
      source: { type: 'file', name: d.formatLabel }
    })
    try {
      const gdir = gameDir(inst.id)
      t.update(0.01, 'Распаковка файлов сборки')
      await src.extract(
        (name) => {
          if (!name.startsWith(d.gameRoot)) return null
          const rel = name.slice(d.gameRoot.length)
          if (!rel) return null
          const top = rel.split('/')[0]
          if (SKIP_DIRS.includes(top) || SKIP_FILES.includes(rel)) return null
          return safeJoin(gdir, rel)
        },
        (done, total) => t.update(0.02 + 0.6 * (done / total), `Распаковка: ${Math.round(done / 1048576)} / ${Math.round(total / 1048576)} МБ`),
        t.signal
      )
      t.detail('Установка Minecraft и загрузчика')
      await ensureInstalled(getInstance(inst.id), t)
      return saveInstance({ ...getInstance(inst.id) })
    } catch (e) {
      deleteInstance(inst.id)
      throw e
    }
  })
}

export function isLikelyImport(p: string): boolean {
  return exists(p) && (fs.statSync(p).isDirectory() || /\.(zip|mrpack)$/i.test(p))
}
