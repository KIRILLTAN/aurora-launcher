import fs from 'fs'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { nativeImage } from 'electron'
import type { Account, LoaderType } from '@shared/types'
import { createInstance, gameDir, getInstance, saveInstance } from './instances'
import { ensureInstalled, launchInstance, resolveJava, stopInstance, runningIds, getLog } from './minecraft/launch'
import { loadVersionJson } from './minecraft/versions'
import { TaskHandle } from './events'
import { dirs, updateSettings } from './settings'
import { overlayDiagnostics } from './overlay'
import { setOfflineAccountSkin } from './auth/accounts'
import { skinServerHits } from './auth/offlineSkins'
import { downloadFile, httpFetch, mirrorOf, testConnection } from './util/net'
import { installModrinthProject } from './catalog/modpacks'
import { listMods } from './mods'

type Log = (k: string, v: string) => void
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const isWin = process.platform === 'win32'

async function waitFor<T>(fn: () => T | undefined | null | false, ms: number): Promise<T | null> {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const v = fn()
    if (v) return v
    await wait(1000)
  }
  return null
}

async function waitExit(id: string): Promise<void> {
  await waitFor(() => !runningIds().includes(id), 60000)
}

function powershell(script: string): string {
  return spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8' }).stdout || ''
}

function screenshot(file: string): void {
  if (isWin) {
    powershell(
      `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.SystemInformation]::VirtualScreen; ` +
        `$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($bmp); ` +
        `$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size); $bmp.Save('${file.replace(/'/g, "''")}')`
    )
  } else spawnSync('import', ['-window', 'root', file], { stdio: 'ignore' })
}

function press(key: 'F6' | 'Down'): void {
  if (isWin) powershell(`Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('{${key.toUpperCase()}}')`)
  else spawnSync('xdotool', ['key', key])
}

/** Размер окна игры (Linux) или экрана (Windows) — для проверки «полного экрана без рамки». */
function gameWindowGeometry(): string {
  if (isWin) return powershell('Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::PrimaryScreen.Bounds').replace(/\s+/g, ' ').trim()
  const ids = (spawnSync('xdotool', ['search', '--name', 'Minecraft'], { encoding: 'utf8' }).stdout || '').trim().split('\n').filter(Boolean)
  return ids.map((id) => (spawnSync('xdotool', ['getwindowgeometry', id], { encoding: 'utf8' }).stdout || '').replace(/\s+/g, ' ').trim()).join(' | ')
}

/** Мир для теста: генерирует его выделенный сервер, а у точки спавна кладём предметы. */
async function makeWorld(mc: string, outWorld: string, log: Log): Promise<boolean> {
  const v = (await loadVersionJson(mc)) as unknown as { downloads?: { server?: { url: string; sha1: string } } }
  const server = v.downloads?.server
  if (!server) return false
  const dir = fs.mkdtempSync(path.join(dirs.cache(), 'srv-'))
  await downloadFile({ url: server.url, path: path.join(dir, 'server.jar'), sha1: server.sha1 })
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n')
  fs.writeFileSync(path.join(dir, 'server.properties'), 'online-mode=false\nlevel-type=minecraft\\:flat\nspawn-protection=0\ngenerate-structures=false\nspawn-monsters=false\n')
  const tmp = createInstance({ name: 'srv-java', mcVersion: mc, loader: 'vanilla' })
  const java = await resolveJava(getInstance(tmp.id), 21)
  const proc = spawn(java.path, ['-Xmx1G', '-jar', 'server.jar', 'nogui'], { cwd: dir })
  let out = ''
  proc.stdout.on('data', (d) => (out += d))
  proc.stderr.on('data', (d) => (out += d))
  const ready = await waitFor(() => /Done \(/.test(out), 180000)
  if (!ready) {
    proc.kill()
    log('world', 'сервер не запустился: ' + out.slice(-500))
    return false
  }
  const cmds = [
    'summon minecraft:item ~4 ~1.5 ~18 {Item:{id:"minecraft:diamond",count:5},NoGravity:1b,Age:-32768,PickupDelay:32767}',
    'summon minecraft:item ~-2 ~1.5 ~14 {Item:{id:"minecraft:golden_apple",count:2},NoGravity:1b,Age:-32768,PickupDelay:32767}',
    'summon minecraft:item ~ ~1 ~6 {Item:{id:"minecraft:oak_log",count:16},NoGravity:1b,Age:-32768,PickupDelay:32767}',
    'save-all flush',
    'stop'
  ]
  for (const c of cmds) {
    proc.stdin.write(c + '\n')
    await wait(1500)
  }
  await waitFor(() => proc.exitCode !== null, 60000)
  fs.cpSync(path.join(dir, 'world'), outWorld, { recursive: true })
  return true
}

async function connectTest(name: string, loader: LoaderType, mc: string, acc: Account, log: Log, mods: string[] = []): Promise<void> {
  const inst = createInstance({ name, mcVersion: mc, loader })
  try {
    for (const m of mods) await installModrinthProject(inst.id, m, 'mod')
    if (mods.length) log(`${name}-mods`, (await listMods(inst.id)).map((m) => `${m.name} ${m.version || ''}`).join('; '))
    const t = new TaskHandle('install')
    await ensureInstalled(getInstance(inst.id), t)
    t.done()
    await launchInstance(inst.id, acc.id)
    const diag = await waitFor(() => overlayDiagnostics().find((d) => d.instance === inst.id && d.connected && d.snapshots > 10), mods.length ? 480000 : 240000)
    log(
      name,
      diag
        ? `ok, снимков=${diag.snapshots}, не найдено: ${diag.missing?.join(', ') || 'ничего'}`
        : 'агент не подключился: ' + getLog(inst.id).filter((l) => /Aurora|Exception|Error/i.test(l)).slice(-6).join(' / ')
    )
    stopInstance(inst.id)
    await waitExit(inst.id)
  } catch (e) {
    log(name, 'FAIL ' + (e as Error).message)
    stopInstance(inst.id)
  }
}

export async function overlaySelfTest(acc: Account, outDir: string, log: Log, windowsOnly = false): Promise<void> {
  updateSettings({
    helperEnabled: true,
    overlay: { loot: true, worldIcons: true, radius: 32, arrows: true, coords: true, fps: true, clock: true, armor: true, offhand: true, rightSide: false, maxLines: 8, borderless: true, autoRefill: false, emergencyTotem: false, totemHp: 0 }
  })

  if (!windowsOnly) {
    // сеть и зеркала
    const net = await testConnection()
    log('net', net.map((r) => `${r.name}=${r.ok ? r.ms + 'мс' : r.error}`).join('; '))
    const checks = [
      'https://libraries.minecraft.net/com/mojang/brigadier/1.3.10/brigadier-1.3.10.jar',
      'https://api.modrinth.com/v2/project/sodium',
      'https://api.curseforge.com/v1/mods/238222',
      'https://meta.fabricmc.net/v2/versions/loader/1.21.1'
    ]
    const mirrorRes: string[] = []
    for (const u of checks) {
      const m = mirrorOf(u)!
      try {
        const r = await httpFetch(m, { signal: AbortSignal.timeout(20000) })
        mirrorRes.push(`${new URL(u).host}→${r.status}`)
      } catch (e) {
        mirrorRes.push(`${new URL(u).host}→${(e as Error).message}`)
      }
    }
    log('mirrors', mirrorRes.join('; '))

    // скин оффлайн-аккаунта
    const px = Buffer.alloc(64 * 64 * 4)
    for (let i = 0; i < 64 * 64; i++) px.set([60, 200, 120, 255], i * 4)
    setOfflineAccountSkin(acc.id, nativeImage.createFromBitmap(px, { width: 64, height: 64 }).toPNG(), false)

    // оверлей на разных загрузчиках и версиях (до главного меню)
    const variants: [LoaderType, string][] = [
      ['vanilla', '1.21.1'],
      ['vanilla', '26.3'],
      ['fabric', '26.3'],
      ['fabric', '1.21.1'],
      ['neoforge', '1.21.1'],
      ['forge', '1.20.1']
    ]
    for (const [loader, mc] of variants) await connectTest(`overlay-${loader}-${mc}`, loader, mc, acc, log)
    // как импортированная сборка: NeoForge 1.21.1 + Create, Sodium, Iris
    await connectTest('overlay-neoforge-create', 'neoforge', '1.21.1', acc, log, ['create', 'sodium', 'iris'])
  }

  // настоящий мир: лут на земле, иконки, меню F6; игра запускается в полноэкранном режиме
  const world = createInstance({ name: 'Оверлей в мире', mcVersion: '1.21.1', loader: 'vanilla' })
  const ok = await makeWorld('1.21.1', path.join(gameDir(world.id), 'saves', 'world'), log).catch((e) => {
    log('world', 'FAIL ' + (e as Error).message)
    return false
  })
  if (!ok) return
  saveInstance({ ...getInstance(world.id), gameArgs: '--quickPlaySingleplayer world', width: 1280, height: 720 })
  // без экрана первичной настройки (доступность), иначе Quick Play не стартует
  fs.writeFileSync(
    path.join(gameDir(world.id), 'options.txt'),
    ['onboardAccessibility:false', 'joinedFirstServer:true', 'skipMultiplayerWarning:true', 'tutorialStep:none', 'renderDistance:6', 'fullscreen:true', ''].join('\n')
  )
  await launchInstance(world.id, acc.id)
  const inGame = await waitFor(() => {
    const d = overlayDiagnostics().find((x) => x.instance === world.id)
    const last = d?.last as { inGame?: boolean; loot?: unknown[] } | undefined
    return last?.inGame && (last.loot?.length || 0) > 0 ? d : null
  }, isWin ? 600000 : 300000)
  if (!inGame) {
    screenshot(path.join(outDir, 'overlay-world-fail.png'))
    log('overlay-world', 'игрок не появился в мире или лут не виден: ' + JSON.stringify(overlayDiagnostics().find((x) => x.instance === world.id)?.last || null).slice(0, 600))
    log('overlay-world-log', getLog(world.id).slice(-40).join('\n'))
  } else {
    await wait(8000)
    screenshot(path.join(outDir, 'overlay-ingame.png'))
    const d = overlayDiagnostics().find((x) => x.instance === world.id)!
    log('overlay-world', JSON.stringify(d.last).slice(0, 900))
    log('overlay-window', `visible=${d.visible} bounds=${JSON.stringify(d.bounds)} game=${gameWindowGeometry()}`)
    log('borderless', getLog(world.id).filter((l) => /AuroraOverlay/.test(l)).join(' / ') || 'нет сообщений агента')
    press('F6')
    await wait(2500)
    screenshot(path.join(outDir, 'overlay-menu.png'))
    press('Down')
    press('F6')
  }
  if (!windowsOnly) log('offline-skin', skinServerHits.filter((h) => !h.endsWith(' /')).slice(0, 8).join(' | ') || 'игра не обращалась к скин-серверу')
  stopInstance(world.id)
  await waitExit(world.id)
}
