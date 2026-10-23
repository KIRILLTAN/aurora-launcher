import fs from 'fs'
import path from 'path'
import type { CrashAnalysis, CrashCause, Instance } from '@shared/types'
import { gameDir } from '../instances'
import { listMods, type ModMeta } from '../mods'
import { getSettings } from '../settings'

/** Известные несовместимые пары модов (id из метаданных). */
const KNOWN_CONFLICTS: [string, string, string][] = [
  ['optifine', 'sodium', 'OptiFine и Sodium заменяют один и тот же рендер'],
  ['optifine', 'iris', 'Iris не работает вместе с OptiFine'],
  ['optifine', 'embeddium', 'OptiFine и Embeddium несовместимы'],
  ['optifine', 'rubidium', 'OptiFine и Rubidium несовместимы'],
  ['optifine', 'oculus', 'Oculus не работает вместе с OptiFine'],
  ['embeddium', 'rubidium', 'Embeddium — это форк Rubidium, оставьте один'],
  ['sodium', 'embeddium', 'Sodium и Embeddium — две версии одного мода'],
  ['sodium', 'rubidium', 'Sodium и Rubidium — две версии одного мода'],
  ['canvas', 'sodium', 'Canvas и Sodium заменяют рендер'],
  ['iris', 'oculus', 'Iris и Oculus — один и тот же мод для разных загрузчиков'],
  ['phosphor', 'starlight', 'Phosphor и Starlight оба переписывают освещение'],
  ['lithium', 'canary', 'Lithium и Canary — один мод для разных загрузчиков'],
  ['modernfix', 'ferritecore', 'Иногда конфликтуют на старых версиях ModernFix']
]

function newestFile(dir: string, since: number, re: RegExp): string | undefined {
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => re.test(f))
      .map((f) => ({ f: path.join(dir, f), t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .filter((x) => x.t >= since - 2000)
      .sort((a, b) => b.t - a.t)[0]?.f
  } catch {
    return undefined
  }
}

function readTail(file: string | undefined, max = 60000): string {
  if (!file) return ''
  try {
    const t = fs.readFileSync(file, 'utf8')
    return t.length > max ? t.slice(0, 20000) + '\n...\n' + t.slice(-(max - 20000)) : t
  } catch {
    return ''
  }
}

function modName(mods: ModMeta[], id: string): string {
  const m = mods.find((x) => x.id === id)
  return m ? `${m.name} (${m.file})` : id
}

export function analyzeCrash(inst: Instance, exitCode: number | null, logLines: string[], startedAt: number): CrashAnalysis {
  const dir = gameDir(inst.id)
  const crashFile = newestFile(path.join(dir, 'crash-reports'), startedAt, /\.txt$/)
  const hsErr = newestFile(dir, startedAt, /^hs_err_pid\d+\.log$/)
  const crashReport = readTail(crashFile)
  const hs = readTail(hsErr, 20000)
  const log = logLines.join('\n')
  const all = `${log}\n${crashReport}\n${hs}`
  const mods = inst.loader === 'vanilla' ? [] : safeMods(inst.id)
  const enabled = mods.filter((m) => m.enabled)
  const causes: CrashCause[] = []
  const suspected = new Set<string>()
  const add = (c: CrashCause): void => {
    if (!causes.some((x) => x.title === c.title)) causes.push(c)
    c.mods?.forEach((m) => suspected.add(m))
  }

  // --- Память
  if (/java\.lang\.OutOfMemoryError|Could not reserve enough space|There is insufficient memory/i.test(all)) {
    add({
      severity: 'high',
      title: 'Не хватило оперативной памяти',
      detail: 'Java исчерпала выделенную память (OutOfMemoryError) или не смогла её зарезервировать.',
      fix: `Увеличьте «Максимум памяти» в настройках сборки (сейчас ${inst.memoryMax || getSettings().memoryMax} МБ). Для больших модпаков нужно 6–8 ГБ. Если не помогает — закройте браузер и другие программы.`
    })
  }

  // --- Неподходящая Java
  const ucv = /UnsupportedClassVersionError.*?class file version (\d+)(?:\.\d+)?/s.exec(all)
  if (ucv) {
    const need = parseInt(ucv[1]) - 44
    add({
      severity: 'high',
      title: `Нужна Java ${need} или новее`,
      detail: `Мод или игра скомпилированы под Java ${need}, а запущена более старая версия.`,
      fix: `Откройте вкладку «Java», установите Java ${need} и выберите «Авто» в настройках сборки.`
    })
  }
  if (/ClassLoaders\$AppClassLoader cannot be cast to class java\.net\.URLClassLoader|Unsupported major\.minor|sun\.misc\.Unsafe\.defineClass|Nashorn/i.test(all)) {
    add({
      severity: 'high',
      title: 'Слишком новая Java для этой версии',
      detail: 'Старые версии Forge (1.7.10–1.16.5) работают только на Java 8.',
      fix: 'Во вкладке «Java» скачайте Java 8 и выберите её в настройках сборки (или режим «Авто»).'
    })
  }
  if (/Could not create the Java Virtual Machine|Unrecognized VM option|Unrecognized option/i.test(all)) {
    const opt = /Unrecognized (?:VM )?option[: ]+'?([^\s']+)/i.exec(all)?.[1]
    add({
      severity: 'high',
      title: 'Java не приняла аргументы запуска',
      detail: opt ? `Неизвестный параметр JVM: ${opt}` : 'Один из JVM-аргументов не поддерживается этой версией Java.',
      fix: 'Удалите лишние аргументы в настройках сборки/лаунчера или смените Java.'
    })
  }

  // --- Fabric/Quilt: несовместимый набор модов
  const fabricBlock = /(?:Incompatible mods? found!|Mod resolution encountered an incompatible mod set!|Some of your mods are incompatible)([\s\S]{0,6000}?)(?:\n\s*at |\n\[|\n\n\n|$)/.exec(all)
  if (fabricBlock) {
    const lines = fabricBlock[1].split('\n').map((l) => l.trim()).filter((l) => /^[-*]|requires|incompatible|is missing|which is missing|breaks/i.test(l))
    const involved = new Set<string>()
    for (const l of lines) {
      for (const m of l.matchAll(/'([^']+)' \(([\w-]+)\)/g)) {
        if (!['minecraft', 'java', 'fabricloader', 'quilt_loader'].includes(m[2])) involved.add(`${m[1]} (${m[2]})`)
      }
    }
    const missing = lines.filter((l) => /missing/i.test(l))
    const wrongGame = lines.filter((l) => /of 'Minecraft' \(minecraft\)/.test(l))
    add({
      severity: 'high',
      title: missing.length
        ? 'Не хватает зависимостей модов'
        : wrongGame.length
          ? `Мод сделан для другой версии Minecraft (у вас ${inst.mcVersion})`
          : 'Моды несовместимы между собой',
      detail: lines.slice(0, 12).join('\n') || 'Загрузчик Fabric/Quilt отказался загружать этот набор модов.',
      mods: [...involved],
      fix: missing.length
        ? 'Установите недостающие моды нужных версий (вкладка «Моды» → «Добавить»), часто это Fabric API.'
        : wrongGame.length
          ? `Удалите ${[...involved].join(', ') || 'этот мод'} или скачайте его версию для Minecraft ${inst.mcVersion} (вкладка «Моды» → «Добавить»).`
          : 'Удалите или обновите один из указанных модов, чтобы версии совпадали.'
    })
  }

  // --- Forge/NeoForge: отсутствующие зависимости
  const forgeMissing = [...all.matchAll(/Mod ID: '([\w-]+)', Requested by: '([\w-]+)', Expected range: '([^']+)', Actual version: '([^']+)'/g)]
  if (forgeMissing.length) {
    add({
      severity: 'high',
      title: 'Не хватает зависимостей модов',
      detail: forgeMissing
        .map((m) => `• ${modName(mods, m[2])} требует ${m[1]} ${m[3]} (сейчас: ${m[4] === '[MISSING]' ? 'не установлен' : m[4]})`)
        .join('\n'),
      mods: forgeMissing.map((m) => modName(mods, m[2])),
      fix: 'Установите недостающие моды подходящих версий или удалите моды, которые их требуют.'
    })
  }
  if (/DuplicateModsFoundException|Found duplicate mods|Duplicate mods found|duplicate mod/i.test(all)) {
    const dup = [...all.matchAll(/Mod ID: '([\w-]+)' from mod files: ([^\n]+)/g)]
    add({
      severity: 'high',
      title: 'Один и тот же мод установлен дважды',
      detail: dup.length ? dup.map((d) => `• ${d[1]}: ${d[2]}`).join('\n') : 'В папке mods есть дубликаты (разные версии одного мода).',
      mods: dup.map((d) => d[1]),
      fix: 'Оставьте только одну, самую новую версию каждого мода.'
    })
  }

  // --- Mixin
  for (const m of all.matchAll(/Mixin \[([^\]]+)\] from mod ([\w-]+) failed injection check|from mod ([\w-]+)[^\n]*?(?:failed|InvalidInjectionException|MixinApplyError)/g)) {
    const id = m[2] || m[3]
    if (!id || id === 'minecraft') continue
    add({
      severity: 'high',
      title: `Мод ${modName(mods, id)} не смог внедриться в игру (Mixin)`,
      detail: 'Обычно это значит, что мод не подходит к версии игры/загрузчика или конфликтует с другим модом, меняющим тот же код.',
      mods: [modName(mods, id)],
      fix: 'Обновите этот мод до версии под вашу версию Minecraft или временно отключите его.'
    })
  }
  const mixinCfg = /Mixin apply for mod ([\w-]+) failed/.exec(all)
  if (mixinCfg) {
    add({ severity: 'high', title: `Ошибка Mixin в моде ${modName(mods, mixinCfg[1])}`, detail: 'Мод не смог применить свои изменения.', mods: [modName(mods, mixinCfg[1])], fix: 'Обновите или отключите мод.' })
  }

  // --- Подозреваемые моды из краш-репорта
  for (const m of crashReport.matchAll(/Suspected Mods?:\s*([^\n]+)/g)) {
    if (/NONE|Unknown/i.test(m[1])) continue
    m[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((s) => suspected.add(s))
  }
  for (const m of crashReport.matchAll(/-- MOD ([\w-]+) --[\s\S]{0,300}?Failure message: ([^\n]+)/g)) {
    add({ severity: 'high', title: `Мод ${modName(mods, m[1])} упал при загрузке`, detail: m[2], mods: [modName(mods, m[1])], fix: 'Обновите мод или удалите его; проверьте его зависимости.' })
  }

  // --- Анализ стектрейса по пакетам модов
  if (enabled.length) {
    const frames = [...`${crashReport}\n${log.slice(-40000)}`.matchAll(/\bat ([\w$.]+)\.[\w$<>]+\(/g)].map((f) => f[1])
    const score = new Map<ModMeta, number>()
    for (const f of frames) {
      for (const mod of enabled) {
        if (mod.packages.some((p) => f.startsWith(p + '.'))) score.set(mod, (score.get(mod) || 0) + 1)
      }
    }
    const top = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3)
    if (top.length) {
      top.forEach(([m]) => suspected.add(`${m.name} (${m.file})`))
      add({
        severity: 'medium',
        title: 'Моды, найденные в стеке ошибки',
        detail: top.map(([m, n]) => `• ${m.name} ${m.version || ''} — ${n} упоминаний`).join('\n'),
        mods: top.map(([m]) => `${m.name} (${m.file})`),
        fix: 'Попробуйте отключить эти моды по одному во вкладке «Моды» и запустить игру снова.'
      })
    }
  }

  // --- Известные конфликты
  const ids = new Set(enabled.map((m) => (m.id || m.name).toLowerCase()))
  const fileIds = enabled.map((m) => m.file.toLowerCase())
  const has = (id: string): boolean => ids.has(id) || fileIds.some((f) => f.startsWith(id))
  for (const [a, b, why] of KNOWN_CONFLICTS) {
    if (has(a) && has(b)) {
      add({ severity: 'high', title: `Конфликт: ${a} + ${b}`, detail: why, mods: [a, b], fix: `Отключите один из модов: ${a} или ${b}.` })
    }
  }

  // --- Моды не того загрузчика
  if (inst.loader !== 'vanilla') {
    const wrong = enabled.filter((m) => {
      if (!m.loaders.length) return false
      if (m.loaders.includes(inst.loader)) return false
      if (inst.loader === 'quilt' && m.loaders.includes('fabric')) return false
      if (inst.loader === 'neoforge' && m.loaders.includes('forge') && /^1\.20\.1/.test(inst.mcVersion)) return false
      if (has('connector') || has('sinytra')) return false
      return true
    })
    if (wrong.length) {
      add({
        severity: 'high',
        title: `Моды для другого загрузчика (нужен ${inst.loader})`,
        detail: wrong.slice(0, 10).map((m) => `• ${m.name} — для ${m.loaders.join('/')}`).join('\n'),
        mods: wrong.map((m) => `${m.name} (${m.file})`),
        fix: `Удалите эти моды или скачайте их версии для ${inst.loader}.`
      })
    }
  }

  // --- Видеодрайвер / OpenGL
  if (/EXCEPTION_ACCESS_VIOLATION|0xC0000005|-1073741819/i.test(all) || exitCode === -1073741819) {
    const drv = /(atio6axx|atig6pxx|amdxx|nvoglv64|nvoglv32|ig\w*icd\d+|igxelpicd64)\.dll/i.exec(all)?.[1]
    add({
      severity: drv ? 'high' : 'medium',
      title: 'Сбой видеодрайвера',
      detail: drv ? `Игра упала внутри драйвера видеокарты (${drv}.dll).` : 'Нативный сбой (ACCESS_VIOLATION) — чаще всего видеодрайвер или моды рендера.',
      fix: 'Обновите драйвер видеокарты с сайта NVIDIA/AMD/Intel. На ноутбуке выберите дискретную видеокарту для javaw.exe. Попробуйте отключить шейдеры и OptiFine/Sodium.'
    })
  }
  if (/Pixel format not accelerated|GLFW error 65542|WGL: The driver does not appear to support OpenGL|Couldn't set pixel format/i.test(all)) {
    add({ severity: 'high', title: 'Видеокарта не поддерживает OpenGL', detail: 'Драйвер не дал OpenGL-контекст.', fix: 'Установите драйвер видеокарты (не стандартный «Microsoft Basic Display»).' })
  }

  // --- Аккаунт
  if (/Invalid session|Failed to verify username|401 Unauthorized.*minecraftservices/i.test(all)) {
    add({ severity: 'medium', title: 'Проблема с сессией аккаунта', detail: 'Сервер не принял токен.', fix: 'Перезайдите в аккаунт во вкладке «Аккаунты».' })
  }

  // --- Повреждённые файлы
  if (/ZipException|invalid LOC header|java\.util\.zip|Error opening zip file|ClassNotFoundException: net\.minecraft/i.test(all) && !causes.length) {
    add({ severity: 'medium', title: 'Повреждённые файлы', detail: 'Какой-то .jar повреждён или не докачан.', fix: 'В меню сборки нажмите «Переустановить версию». Если виноват мод — перекачайте его.' })
  }

  // --- Общий случай
  const exception = /(?:Exception in thread "[^"]+" |Caused by: |Description: [^\n]*\n\n)?([\w.$]+(?:Exception|Error))(?::\s*([^\n]{0,240}))?/.exec(crashReport || log.slice(-20000))
  if (!causes.length) {
    add({
      severity: 'low',
      title: exception ? `Ошибка: ${exception[1].split('.').pop()}` : `Игра завершилась с кодом ${exitCode}`,
      detail: exception?.[2] || 'Точную причину по логу определить не удалось.',
      fix: suspected.size
        ? 'Попробуйте отключить подозрительные моды. Также можно нажать «Спросить ИИ» для подробного разбора.'
        : 'Нажмите «Спросить ИИ» для подробного разбора лога или проверьте последние строки лога ниже.'
    })
  }

  const desc = /^Description: (.+)$/m.exec(crashReport)?.[1]
  const s = getSettings()
  return {
    instanceId: inst.id,
    exitCode,
    title: causes[0].severity === 'low' ? 'Игра неожиданно закрылась' : causes[0].title,
    summary: desc ? `Краш-репорт: «${desc}»` : `Код выхода: ${exitCode}`,
    causes,
    suspectedMods: [...suspected].slice(0, 10),
    crashReport: crashReport || undefined,
    logTail: logLines.slice(-400).join('\n'),
    aiAvailable: s.aiEnabled && !!s.anthropicKey
  }
}

function safeMods(id: string): ModMeta[] {
  try {
    return listMods(id, true)
  } catch {
    return []
  }
}
