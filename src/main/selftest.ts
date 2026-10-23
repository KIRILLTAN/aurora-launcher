import fs from 'fs'
import path from 'path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { addOffline } from './auth/accounts'
import { createInstance, getInstance } from './instances'
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
    updateSettings({ afterLaunch: 'keep' })
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
  } catch (e) {
    log('fatal', (e as Error).stack || String(e))
  }
  ipcMain.removeAllListeners()
  app.exit(0)
}
