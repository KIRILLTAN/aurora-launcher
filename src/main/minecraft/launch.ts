import fs from 'fs'
import path from 'path'
import { spawn, type ChildProcess } from 'child_process'
import { app, BrowserWindow } from 'electron'
import type { Instance, JavaInstall } from '@shared/types'
import { dirs, getSettings } from '../settings'
import { emit, TaskHandle } from '../events'
import { gameDir, getInstance, saveInstance } from '../instances'
import { getLaunchAuth } from '../auth/accounts'
import { exists, ensureDir } from '../util/store'
import { analyzeCrash } from '../crash/analyzer'
import { cachedJavas, detectJavas, installJava, launchBinary, pickJava, probeJava, requiredJavaMajor } from '../java/java'
import { installVersion, collectLibraries, clientJarPath, nativesDir, ensureAuthlibInjector } from './install'
import { installLoader } from './loaders'
import { applyHelper } from '../helper'
import { autoPush } from '../sync'
import { resolveVersion, rulesAllow, type Argument, type ResolvedVersion } from './versions'

interface Running {
  proc: ChildProcess
  startedAt: number
  log: string[]
  java: JavaInstall
}

const running = new Map<string, Running>()

export function runningIds(): string[] {
  return [...running.keys()]
}

export function stopInstance(id: string): void {
  running.get(id)?.proc.kill()
}

export function getLog(id: string): string[] {
  return running.get(id)?.log || lastLogs.get(id) || []
}

const lastLogs = new Map<string, string[]>()

/** Подбирает Java для версии: из настроек сборки, установленных или скачивает автоматически. */
export async function resolveJava(inst: Instance, required: number, task?: TaskHandle): Promise<JavaInstall> {
  if (inst.javaPath) {
    const info = await probeJava(inst.javaPath)
    if (!info) throw new Error(`Указанная Java не запускается: ${inst.javaPath}`)
    return { ...info, source: 'manual' }
  }
  let java = pickJava(required)
  if (!java) {
    await detectJavas()
    java = pickJava(required, cachedJavas())
  }
  if (!java) {
    if (!getSettings().autoJava) throw new Error(`Нужна Java ${required}. Установите её во вкладке «Java».`)
    task?.detail(`Скачивание Java ${required}`)
    java = await installJava(required, task)
  }
  return java
}

/** Устанавливает версию и загрузчик сборки, если ещё не установлены. */
export async function ensureInstalled(inst: Instance, task: TaskHandle, force = false): Promise<ResolvedVersion> {
  let versionId = inst.versionId
  if (force || !versionId || !exists(path.join(dirs.versions(), versionId, `${versionId}.json`))) {
    task.detail('Установка версии')
    versionId = await installLoader(
      inst.loader,
      inst.mcVersion,
      inst.loaderVersion,
      async () => (await resolveJava(inst, requiredJavaMajor(inst.mcVersion), task)).path,
      task
    )
    inst.versionId = versionId
    saveInstance(inst)
  }
  return installVersion(versionId, task, gameDir(inst.id))
}

function substitute(s: string, vars: Record<string, string>): string {
  return s.replace(/\$\{([^}]+)\}/g, (m, k: string) => (k in vars ? vars[k] : m))
}

function expandArgs(args: Argument[] | undefined, vars: Record<string, string>, features: Record<string, boolean>): string[] {
  const out: string[] = []
  for (const a of args || []) {
    if (typeof a === 'string') out.push(substitute(a, vars))
    else if (rulesAllow(a.rules, features)) {
      for (const v of Array.isArray(a.value) ? a.value : [a.value]) out.push(substitute(v, vars))
    }
  }
  return out
}

function splitArgs(s: string | undefined): string[] {
  if (!s) return []
  return (s.match(/(?:[^\s"]+|"[^"]*")+/g) || []).map((x) => x.replace(/^"|"$/g, ''))
}

/** log4j XML-события в обычные строки */
function createLogParser(onLine: (line: string, level?: 'info' | 'warn' | 'error') => void): (chunk: string) => void {
  let buf = ''
  return (chunk) => {
    buf += chunk
    for (;;) {
      const xmlStart = buf.indexOf('<log4j:Event')
      const nl = buf.indexOf('\n')
      if (xmlStart === 0) {
        const end = buf.indexOf('</log4j:Event>')
        if (end < 0) return
        const ev = buf.slice(0, end + 14)
        buf = buf.slice(end + 14).replace(/^\r?\n/, '')
        const level = /level="(\w+)"/.exec(ev)?.[1] || 'INFO'
        const thread = /thread="([^"]*)"/.exec(ev)?.[1] || ''
        const ts = parseInt(/timestamp="(\d+)"/.exec(ev)?.[1] || '0')
        const msg = /<log4j:Message><!\[CDATA\[([\s\S]*?)\]\]><\/log4j:Message>/.exec(ev)?.[1] || ''
        const thr = /<log4j:Throwable><!\[CDATA\[([\s\S]*?)\]\]><\/log4j:Throwable>/.exec(ev)?.[1]
        const time = ts ? new Date(ts).toTimeString().slice(0, 8) : ''
        const lv = level === 'ERROR' || level === 'FATAL' ? 'error' : level === 'WARN' ? 'warn' : 'info'
        onLine(`[${time}] [${thread}/${level}]: ${msg}`, lv)
        if (thr) for (const l of thr.split(/\r?\n/)) if (l) onLine(l, 'error')
        continue
      }
      if (nl < 0) return
      if (xmlStart > 0 && xmlStart < nl) {
        const pre = buf.slice(0, xmlStart)
        buf = buf.slice(xmlStart)
        if (pre.trim()) onLine(pre.trimEnd())
        continue
      }
      const line = buf.slice(0, nl).replace(/\r$/, '')
      buf = buf.slice(nl + 1)
      const lv = /\/(ERROR|FATAL)\]|Exception|^\s+at /.test(line) ? 'error' : /\/WARN\]/.test(line) ? 'warn' : 'info'
      onLine(line, lv)
    }
  }
}

export async function launchInstance(id: string, accountId: string | undefined, quickPlayServer?: string): Promise<void> {
  if (running.has(id)) throw new Error('Эта сборка уже запущена')
  const inst = getInstance(id)
  const s = getSettings()
  if (!accountId) throw new Error('Выберите аккаунт для игры')
  const task = new TaskHandle(`Запуск «${inst.name}»`)
  try {
    task.detail('Проверка аккаунта')
    const auth = await getLaunchAuth(accountId)

    const v = await ensureInstalled(inst, task)
    const required = requiredJavaMajor(inst.mcVersion, v.javaVersion?.majorVersion)
    task.detail('Подбор Java')
    const java = await resolveJava(inst, required, task)

    const gdir = gameDir(id)
    task.detail('Подготовка модов')
    await applyHelper(inst)
    const libs = collectLibraries(v)
    const jar = clientJarPath(v.id)
    const classpath = [...libs.classpath.filter((p) => exists(p)), exists(jar) ? jar : clientJarPath(v.rootId)]
    const natives = ensureDir(nativesDir(v.id))
    const assetsRoot = dirs.assets()
    const assetId = v.assetIndex?.id || v.assets || 'legacy'
    const virtual = path.join(assetsRoot, 'virtual', assetId)

    const vars: Record<string, string> = {
      auth_player_name: auth.name,
      version_name: v.id,
      game_directory: gdir,
      assets_root: assetsRoot,
      game_assets: exists(virtual) ? virtual : assetsRoot,
      assets_index_name: assetId,
      auth_uuid: auth.uuid,
      auth_access_token: auth.accessToken,
      auth_session: auth.accessToken === '0' ? '-' : `token:${auth.accessToken}:${auth.uuid}`,
      auth_xuid: auth.xuid,
      clientid: '0',
      user_type: auth.userType,
      user_properties: '{}',
      version_type: 'Aurora',
      natives_directory: natives,
      launcher_name: 'Aurora Launcher',
      launcher_version: app.getVersion(),
      classpath: classpath.join(path.delimiter),
      classpath_separator: path.delimiter,
      library_directory: dirs.libraries(),
      resolution_width: String(inst.width || s.width),
      resolution_height: String(inst.height || s.height),
      quickPlayMultiplayer: quickPlayServer || '',
      quickPlayPath: path.join(gdir, 'quickPlay.json')
    }
    const features: Record<string, boolean> = { has_custom_resolution: true, has_quick_plays_support: false, is_quick_play_multiplayer: !!quickPlayServer }

    const jvm: string[] = [`-Xms${inst.memoryMin || s.memoryMin}M`, `-Xmx${inst.memoryMax || s.memoryMax}M`]
    jvm.push(...splitArgs(inst.jvmArgs ?? s.jvmArgs))
    jvm.push('-Dlog4j2.formatMsgNoLookups=true')
    if (auth.injector) {
      task.detail('Подготовка authlib-injector')
      const injector = await ensureAuthlibInjector()
      jvm.push(`-javaagent:${injector}=${auth.injector}`, '-Dauthlibinjector.side=client')
    }
    if (v.logging?.client?.argument) {
      const logCfg = path.join(assetsRoot, 'log_configs', v.logging.client.file.id)
      if (exists(logCfg)) jvm.push(v.logging.client.argument.replace('${path}', logCfg))
    }
    if (v.arguments?.jvm) {
      jvm.push(...expandArgs(v.arguments.jvm, vars, features))
    } else {
      if (process.platform === 'darwin') jvm.push('-XstartOnFirstThread')
      if (process.platform === 'win32') jvm.push('-XX:HeapDumpPath=MojangTricksIntelDriversForPerformance_javaw.exe_minecraft.exe.heapdump')
      jvm.push(`-Djava.library.path=${natives}`, '-cp', vars.classpath)
    }
    // некоторые загрузчики не передают classpath — добавляем сами
    if (!jvm.includes('-cp') && !jvm.includes('-classpath')) jvm.push('-cp', vars.classpath)

    let game: string[] = v.arguments?.game
      ? expandArgs(v.arguments.game, vars, features)
      : splitArgs(v.minecraftArguments).map((a) => substitute(a, vars))
    if (!v.arguments?.game) game.push('--width', vars.resolution_width, '--height', vars.resolution_height)
    if (quickPlayServer && !v.arguments?.game?.some((a) => typeof a !== 'string' && JSON.stringify(a).includes('quickPlayMultiplayer'))) {
      const [host, port] = quickPlayServer.split(':')
      game.push('--server', host, '--port', port || '25565')
    }
    if (inst.fullscreen) game.push('--fullscreen')
    game.push(...splitArgs(inst.gameArgs))
    game = game.filter((g, i, arr) => !(g === '--quickPlayPath' || arr[i - 1] === '--quickPlayPath'))

    const bin = launchBinary(java.path)
    const args = [...jvm, v.mainClass, ...game]
    task.update(1, 'Игра запускается')

    const logFile = path.join(ensureDir(path.join(gdir, 'logs')), 'aurora-launcher.log')
    const out = fs.createWriteStream(logFile)
    const masked = args.map((a) => (a === auth.accessToken && a !== '0' ? '••••••' : a))
    out.write(`Aurora Launcher ${app.getVersion()} | ${inst.name} | ${v.id}\nJava: ${java.path} (${java.version})\n${bin} ${masked.join(' ')}\n\n`)

    const proc = spawn(bin, args, { cwd: gdir, windowsHide: false, env: { ...process.env, JAVA_TOOL_OPTIONS: undefined } })
    const r: Running = { proc, startedAt: Date.now(), log: [], java }
    running.set(id, r)
    emit('game:state', { instanceId: id, running: true })

    const push = (line: string, level?: 'info' | 'warn' | 'error'): void => {
      const clean = line.split(auth.accessToken).join(auth.accessToken === '0' ? '0' : '••••••')
      r.log.push(clean)
      if (r.log.length > 5000) r.log.splice(0, r.log.length - 5000)
      out.write(clean + '\n')
      emit('game:log', { instanceId: id, line: clean, level })
    }
    const parse = createLogParser(push)
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdout?.on('data', parse)
    proc.stderr?.on('data', (d: string) => d.split(/\r?\n/).filter(Boolean).forEach((l) => push(l, 'error')))
    proc.on('error', (e) => push(`[Aurora] Не удалось запустить Java: ${e.message}`, 'error'))

    task.done('Игра запущена')
    proc.on('close', (code) => {
      out.end()
      running.delete(id)
      lastLogs.set(id, r.log)
      const cur = getInstance(id)
      cur.lastPlayed = Date.now()
      cur.playTime = (cur.playTime || 0) + Math.round((Date.now() - r.startedAt) / 1000)
      saveInstance(cur)
      const crashed = code !== 0 && code !== null && code !== 130 && code !== 143
      const analysis = crashed ? analyzeCrash(cur, code, r.log, r.startedAt) : null
      if (running.size === 0 || crashed) {
        for (const w of BrowserWindow.getAllWindows()) {
          w.show()
          if (crashed) w.focus()
        }
      }
      emit('game:exit', { instanceId: id, code, analysis, java: `${java.version} (${java.path})` })
      void autoPush(id)
    })
  } catch (e) {
    task.fail(e)
    throw e
  }
}

export async function reinstallInstance(id: string): Promise<void> {
  const inst = getInstance(id)
  const task = new TaskHandle(`Переустановка «${inst.name}»`)
  try {
    if (inst.versionId) fs.rmSync(path.join(dirs.versions(), inst.versionId, 'natives'), { recursive: true, force: true })
    await ensureInstalled(inst, task, true)
    task.done()
  } catch (e) {
    task.fail(e)
    throw e
  }
}

export { resolveVersion }
