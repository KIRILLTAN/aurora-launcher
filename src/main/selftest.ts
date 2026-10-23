import fs from 'fs'
import path from 'path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { addOffline } from './auth/accounts'
import { createInstance, getInstance, gameDir, deleteInstance } from './instances'
import { useFolder, pushInstances, listRemote, pullInstance } from './sync'
import { ensureInstalled, launchInstance, stopInstance } from './minecraft/launch'
import { TaskHandle } from './events'
import { updateSettings } from './settings'
import { modrinthVersions } from './catalog/modrinth'
import { installModrinthProject } from './catalog/modpacks'

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
    log('helper', lines.some((l) => l.includes('Aurora Helper loaded')) ? 'ok' : 'НЕ загрузился')
    const helperErr = lines.find((l) => /aurora_helper|AuroraHelper/.test(l) && /error|fail/i.test(l))
    if (helperErr) log('helper-error', helperErr)
    fs.writeFileSync(path.join(outDir, 'game.log'), lines.join('\n'))
    stopInstance(vanilla.id)
    await wait(5000)

    // Краш: мод для другой версии игры — анализатор должен назвать его
    const crashInst = createInstance({ name: 'Тест краш', mcVersion: '1.21.1', loader: 'fabric', jvmArgs: '-Djava.awt.headless=true' })
    const vers = await modrinthVersions('sodium', '1.20.1', 'fabric')
    await installModrinthProject(crashInst.id, 'sodium', 'mod', vers[0].id)
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
  } catch (e) {
    log('fatal', (e as Error).stack || String(e))
  }
  ipcMain.removeAllListeners()
  app.exit(0)
}
