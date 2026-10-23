import fs from 'fs'
import path from 'path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { addOffline } from './auth/accounts'
import AdmZip from 'adm-zip'
import type { Task } from '@shared/types'
import { createInstance, getInstance, gameDir, deleteInstance, listInstances } from './instances'
import { inspectImport, importInstance } from './importer'
import { useFolder, pushInstances, listRemote, pullInstance } from './sync'
import { ensureInstalled, launchInstance, stopInstance } from './minecraft/launch'
import { TaskHandle, cancelTask } from './events'
import { updateSettings } from './settings'
import { modrinthVersions } from './catalog/modrinth'
import { overlaySelfTest } from './selftestOverlay'
import { listMods, toggleMod } from './mods'
import { installModrinthProject, installModrinthPack } from './catalog/modpacks'

/**
 * Самопроверка для CI (AURORA_SELFTEST=<папка>): скриншоты страниц,
 * установка загрузчиков и реальный запуск Minecraft с оффлайн-аккаунтом.
 */
export async function runSelfTest(win: BrowserWindow, outDir: string): Promise<void> {
  fs.mkdirSync(outDir, { recursive: true })
  const results: Record<string, string> = {}
  const log = (k: string, v: string): void => {
    results[k] = v
    console.log(`[selftest] ${k}: ${v}`)
    fs.writeFileSync(path.join(outDir, 'result.json'), JSON.stringify(results, null, 2))
  }
  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
  const shot = async (name: string): Promise<void> => {
    const img = await win.webContents.capturePage()
    fs.writeFileSync(path.join(outDir, `${name}.png`), img.toPNG())
  }
  const go = (page: string): Promise<unknown> => win.webContents.executeJavaScript(`window.__aurora.getState().go(${JSON.stringify(page)})`)

  try {
    updateSettings({ afterLaunch: 'keep', helperEnabled: true, servers: [{ name: 'Hypixel', address: 'mc.hypixel.net' }] })
    const acc = addOffline('AuroraTest')
    await wait(4000)
    await win.webContents.executeJavaScript('window.__aurora.getState().refresh()')

    // оверлей-помощник на разных загрузчиках, мир с лутом, скин оффлайн-аккаунта, зеркала
    try {
      await overlaySelfTest(acc, outDir, log)
    } catch (e) {
      log('overlay-fatal', (e as Error).stack || String(e))
    }

    const vanilla = createInstance({ name: 'Тест Fabric 1.21.1', mcVersion: '1.21.1', loader: 'fabric' })
    for (const [loader, mc] of [['forge', '1.20.1'], ['neoforge', '1.21.1'], ['forge', '1.12.2']] as const) {
      const inst = createInstance({ name: `Тест ${loader} ${mc}`, mcVersion: mc, loader })
      const t = new TaskHandle(`selftest ${loader} ${mc}`)
      try {
        const v = await ensureInstalled(getInstance(inst.id), t)
        log(`install-${loader}-${mc}`, `ok ${v.id}`)
      } catch (e) {
        log(`install-${loader}-${mc}`, `FAIL ${(e as Error).message}`)
      }
      t.done()
    }

    for (const page of ['home', 'library', 'catalog', 'accounts', 'java', 'skins', 'settings']) {
      await go(page)
      await wait(page === 'catalog' || page === 'java' ? 6000 : 2500)
      await shot(`page-${page}`)
    }
    await win.webContents.executeJavaScript(`window.__aurora.getState().go('instance', ${JSON.stringify(vanilla.id)})`)
    await wait(2500)
    await shot('page-instance')
    await win.webContents.executeJavaScript(`window.__aurora.getState().setCreateOpen(true)`)
    await wait(4000)
    await shot('dialog-create')
    await win.webContents.executeJavaScript(`window.__aurora.getState().setCreateOpen(false)`)

    // Реальный запуск игры
    const lines: string[] = []
    let onExit: ((p: never) => void) | undefined
    let taskLog: Task[] = []
    const started = new Promise<string>((resolve) => {
      const timer = setInterval(() => {
        const text = lines.join('\n')
        if (/Sound engine started|Created: \d+x\d+|Backend library: LWJGL|Loaded \d+ mods?/i.test(text)) {
          clearInterval(timer)
          resolve('ok')
        }
      }, 1000)
      setTimeout(() => {
        clearInterval(timer)
        resolve('timeout')
      }, 6 * 60_000)
    })
    const orig = win.webContents.send.bind(win.webContents)
    win.webContents.send = ((ch: string, payload: { line: string; analysis?: unknown }) => {
      if (ch === 'game:log') lines.push(payload.line)
      if (ch === 'task:update') {
        const t = payload as unknown as Task
        taskLog = [t, ...taskLog.filter((x) => x.id !== t.id)]
      }
      if (ch === 'game:exit') {
        log('game-exit', JSON.stringify(payload).slice(0, 300))
        onExit?.(payload as never)
      }
      return orig(ch, payload)
    }) as typeof win.webContents.send
    await launchInstance(vanilla.id, acc.id)
    const res = await started
    log('launch-fabric-1.21.1', res)
    await wait(20000)
    await shot('during-game')
    fs.writeFileSync(path.join(outDir, 'game.log'), lines.join('\n'))
    stopInstance(vanilla.id)
    await wait(5000)

    // Краш: мод для другой версии игры — анализатор должен назвать его
    const crashInst = createInstance({ name: 'Тест краш', mcVersion: '1.21.1', loader: 'fabric', jvmArgs: '-Djava.awt.headless=true' })
    const vers = await modrinthVersions('sodium', '1.20.1', 'fabric')
    await installModrinthProject(crashInst.id, 'sodium', 'mod', vers[0].id)
    // чтение модов: первое — по оглавлению jar, повторное — из кеша; переключение без перечитывания
    {
      let t0 = Date.now()
      const first = await listMods(crashInst.id)
      const tFirst = Date.now() - t0
      const name = await toggleMod(crashInst.id, first[0].file, false)
      t0 = Date.now()
      const again = await listMods(crashInst.id)
      const tAgain = Date.now() - t0
      await toggleMod(crashInst.id, name, true)
      log('mods-list', `${first.map((m) => `${m.name} ${m.version} [${m.loaders.join(',')}]`).join('; ')} | первое=${tFirst}мс кеш=${tAgain}мс выключен=${!again[0].enabled} файл=${name}`)
    }
    const exited = new Promise<{ analysis?: { title: string; causes: { title: string }[]; suspectedMods: string[] } }>((resolve) => {
      onExit = resolve
      setTimeout(() => resolve({}), 5 * 60_000)
    })
    await launchInstance(crashInst.id, acc.id)
    const ex = await exited
    log('crash-analysis', ex.analysis ? `${ex.analysis.title} | ${ex.analysis.causes.map((c) => c.title).join(' ; ')} | mods: ${ex.analysis.suspectedMods.join(', ')}` : 'нет анализа')
    await wait(3000)
    await shot('dialog-crash')

    // Синхронизация через облачную папку: отправить, удалить локально, скачать обратно
    await win.webContents.executeJavaScript('window.__aurora.getState().setCrash(undefined)')
    const syncInst = createInstance({ name: 'Тест синк', mcVersion: '1.21.1', loader: 'fabric' })
    await installModrinthProject(syncInst.id, 'lithium', 'mod')
    fs.mkdirSync(path.join(gameDir(syncInst.id), 'config'), { recursive: true })
    fs.writeFileSync(path.join(gameDir(syncInst.id), 'config', 'aurora-test.txt'), 'привет из облака')
    fs.writeFileSync(path.join(gameDir(syncInst.id), 'mods', 'my-local-mod.jar'), 'not a real jar')
    useFolder(path.join(outDir, 'cloud'))
    const pushed = await pushInstances([syncInst.id])
    deleteInstance(syncInst.id)
    const state = (await listRemote()).find((r) => r.id === syncInst.id)?.state
    const pulled = await pullInstance(syncInst.id)
    const mods = fs.readdirSync(path.join(gameDir(pulled.id), 'mods'))
    const cfg = fs.readFileSync(path.join(gameDir(pulled.id), 'config', 'aurora-test.txt'), 'utf8')
    log('sync', `pushed=${pushed.pushed} state=${state} sameId=${pulled.id === syncInst.id} mods=${mods.join(',')} config=${cfg}`)
    await win.webContents.executeJavaScript('window.__aurora.getState().refresh()')
    await go('accounts')
    await wait(4000)
    await shot('page-accounts-cloud')
    await go('library')
    await wait(2500)
    await shot('page-library-cloud')
    await go('home')
    await wait(6000)
    await shot('page-home-servers')

    // Импорт «живой» сборки в формате Prism Launcher / MultiMC
    const prism = new AdmZip()
    const root = 'Моя сборка Prism/'
    prism.addFile(root + 'mmc-pack.json', Buffer.from(JSON.stringify({ components: [{ uid: 'net.minecraft', version: '1.21.1' }, { uid: 'net.fabricmc.fabric-loader', version: '0.16.5' }], formatVersion: 1 })))
    prism.addFile(root + 'instance.cfg', Buffer.from('[General]\nname=Выживалка из Prism\ntotalTimePlayed=7200\n'))
    prism.addFile(root + 'minecraft/config/test.toml', Buffer.from('a = 1'))
    prism.addFile(root + 'minecraft/saves/Мир/level.dat', Buffer.from('fake'))
    prism.addFile(root + 'minecraft/logs/latest.log', Buffer.from('skip me'))
    prism.addFile(root + 'minecraft/options.txt', Buffer.from('renderDistance:8\n'))
    const prismFile = path.join(outDir, 'prism-export.zip')
    prism.writeZip(prismFile)
    const preview = await inspectImport(prismFile)
    log('import-inspect', `${preview.format} ${preview.name} ${preview.mcVersion} ${preview.loader} ${preview.loaderVersion} worlds=${preview.worlds} play=${preview.playTime}`)
    const imported = await importInstance(prismFile)
    const g = gameDir(imported.id)
    log('import', `id=${imported.id} world=${fs.existsSync(path.join(g, 'saves', 'Мир', 'level.dat'))} logsSkipped=${!fs.existsSync(path.join(g, 'logs', 'latest.log'))} version=${getInstance(imported.id).versionId}`)

    // Отмена установки большого модпака
    let cancelled = 'не отменилось'
    const watcher = setInterval(() => {
      const t = taskLog.find((x) => x.cancellable && x.status === 'running' && x.title.includes('Modrinth') && x.progress > 0.05)
      if (t) {
        clearInterval(watcher)
        cancelTask(t.id)
      }
    }, 300)
    const before = listInstances().length
    try {
      await installModrinthPack('fabulously-optimized')
    } catch (e) {
      cancelled = `${(e as Error).message}; сборок до=${before} после=${listInstances().length}`
    }
    clearInterval(watcher)
    log('cancel', cancelled)
    await go('library')
    await wait(2500)
    await shot('page-library-import')
  } catch (e) {
    log('fatal', (e as Error).stack || String(e))
  }
  ipcMain.removeAllListeners()
  app.exit(0)
}
