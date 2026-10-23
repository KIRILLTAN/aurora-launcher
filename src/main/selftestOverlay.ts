import fs from 'fs'
import path from 'path'
import { spawn, spawnSync } from 'child_process'
import { nativeImage } from 'electron'
import type { Account, LoaderType } from '@shared/types'
import { createInstance, gameDir, getInstance, saveInstance } from './instances'
import { ensureInstalled, launchInstance, resolveJava, stopInstance, runningIds } from './minecraft/launch'
import { loadVersionJson } from './minecraft/versions'
import { TaskHandle } from './events'
import { dirs, updateSettings } from './settings'
import { overlayDiagnostics } from './overlay'
import { setOfflineAccountSkin } from './auth/accounts'
import { skinServerHits } from './auth/offlineSkins'
import { downloadFile, httpFetch, mirrorOf, testConnection } from './util/net'

type Log = (k: string, v: string) => void
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

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

function screenshot(file: string): void {
  spawnSync('import', ['-window', 'root', file], { stdio: 'ignore' })
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
    'summon minecraft:item ~2 ~1 ~ {Item:{id:"minecraft:diamond",count:5},NoGravity:1b,Age:-32768,PickupDelay:32767}',
    'summon minecraft:item ~-3 ~1 ~2 {Item:{id:"minecraft:golden_apple",count:2},NoGravity:1b,Age:-32768,PickupDelay:32767}',
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

export async function overlaySelfTest(acc: Account, outDir: string, log: Log): Promise<void> {
  updateSettings({
    helperEnabled: true,
    overlay: { loot: true, worldIcons: true, radius: 32, arrows: true, coords: true, fps: true, clock: true, armor: true, offhand: true, rightSide: false, maxLines: 8 }
  })

  // сеть и зеркала
  const net = await testConnection()
  log('net', net.map((r) => `${r.name}=${r.ok ? r.ms + 'мс' : r.error}`).join('; '))
  const checks = [
    'https://libraries.minecraft.net/com/mojang/brigadier/1.3.10/brigadier-1.3.10.jar',
    'https://resources.download.minecraft.net/bd/bdf48ef6b5d0d23bbb02e17d04865216179f510a',
    'https://api.modrinth.com/v2/project/sodium',
    'https://api.curseforge.com/v1/mods/238222',
    'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml',
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

  // оверлей на разных загрузчиках (до главного меню)
  const variants: [LoaderType, string][] = [
    ['vanilla', '1.21.1'],
    ['fabric', '1.21.1'],
    ['neoforge', '1.21.1'],
    ['forge', '1.20.1']
  ]
  for (const [loader, mc] of variants) {
    const inst = createInstance({ name: `Оверлей ${loader} ${mc}`, mcVersion: mc, loader })
    try {
      const t = new TaskHandle('install')
      await ensureInstalled(getInstance(inst.id), t)
      t.done()
      await launchInstance(inst.id, acc.id)
      const diag = await waitFor(() => overlayDiagnostics().find((d) => d.instance === inst.id && d.connected && d.snapshots > 10), 240000)
      log(`overlay-${loader}-${mc}`, diag ? `ok, снимков=${diag.snapshots}, не найдено: ${diag.missing?.join(', ') || 'ничего'}` : 'агент не подключился')
      stopInstance(inst.id)
      await waitExit(inst.id)
    } catch (e) {
      log(`overlay-${loader}-${mc}`, 'FAIL ' + (e as Error).message)
      stopInstance(inst.id)
    }
  }

  // настоящий мир: лут на земле, иконки, меню F6
  const world = createInstance({ name: 'Оверлей в мире', mcVersion: '1.21.1', loader: 'vanilla' })
  const ok = await makeWorld('1.21.1', path.join(gameDir(world.id), 'saves', 'world'), log).catch((e) => {
    log('world', 'FAIL ' + (e as Error).message)
    return false
  })
  if (!ok) return
  saveInstance({ ...getInstance(world.id), gameArgs: '--quickPlaySingleplayer world', width: 1280, height: 720 })
  // без экрана первичной настройки (доступность), иначе Quick Play не стартует
  fs.writeFileSync(path.join(gameDir(world.id), 'options.txt'), 'onboardAccessibility:false
joinedFirstServer:true
skipMultiplayerWarning:true
tutorialStep:none
renderDistance:6
')
  await launchInstance(world.id, acc.id)
  const inGame = await waitFor(() => {
    const d = overlayDiagnostics().find((x) => x.instance === world.id)
    const last = d?.last as { inGame?: boolean; loot?: unknown[] } | undefined
    return last?.inGame && (last.loot?.length || 0) > 0 ? d : null
  }, 300000)
  if (!inGame) {
    screenshot(path.join(outDir, 'overlay-world-fail.png'))
    log('overlay-world', 'игрок не появился в мире или лут не виден: ' + JSON.stringify(overlayDiagnostics().find((x) => x.instance === world.id)?.last || null).slice(0, 600))
  } else {
    await wait(8000)
    screenshot(path.join(outDir, 'overlay-ingame.png'))
    const last = overlayDiagnostics().find((x) => x.instance === world.id)?.last as Record<string, unknown>
    log('overlay-world', JSON.stringify(last).slice(0, 900))
    spawnSync('xdotool', ['key', 'F6'])
    await wait(2500)
    screenshot(path.join(outDir, 'overlay-menu.png'))
    spawnSync('xdotool', ['key', 'Down'])
    spawnSync('xdotool', ['key', 'F6'])
  }
  log('offline-skin', skinServerHits.filter((h) => !h.endsWith(' /')).slice(0, 8).join(' | ') || 'игра не обращалась к скин-серверу')
  stopInstance(world.id)
  await waitExit(world.id)
}
