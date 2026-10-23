import fs from 'fs'
import path from 'path'
import { readZipText } from '../util/zip'
import type { Instance } from '@shared/types'
import { dirs } from '../settings'
import { downloadFile } from '../util/net'
import { exists, ensureDir } from '../util/store'
import { compareMc, mavenPath, type ResolvedVersion } from '../minecraft/versions'

/*
 * Оверлей читает игру через рефлексию, а имена классов/методов внутри игры
 * зависят от версии и загрузчика:
 *  - ванилла до 26.1 — обфусцированные имена (берём из официальных маппингов Mojang);
 *  - Fabric/Quilt — intermediary (class_310, method_1551…);
 *  - Forge 1.17–1.20.4 и NeoForge 1.20.1–1.20.4 — классы Mojang, члены SRG (m_91087_…);
 *  - NeoForge 1.20.5+, Forge 1.20.6+ и Minecraft 26.1+ — сразу имена Mojang.
 * Здесь мы переводим нужные агенту имена Mojang в «боевые» и пишем их в файл.
 */

type Need = { cls: string; name: string; argc?: number; field?: boolean }

const C = {
  MC: 'net.minecraft.client.Minecraft',
  ENTITY: 'net.minecraft.world.entity.Entity',
  LIVING: 'net.minecraft.world.entity.LivingEntity',
  ITEM_ENTITY: 'net.minecraft.world.entity.item.ItemEntity',
  STACK: 'net.minecraft.world.item.ItemStack',
  TEXT: 'net.minecraft.network.chat.FormattedText',
  COMPONENT: 'net.minecraft.network.chat.Component',
  CLEVEL: 'net.minecraft.client.multiplayer.ClientLevel',
  LEVEL: 'net.minecraft.world.level.Level',
  GAME_RENDERER: 'net.minecraft.client.renderer.GameRenderer',
  CAMERA: 'net.minecraft.client.Camera',
  VEC3: 'net.minecraft.world.phys.Vec3',
  OPTIONS: 'net.minecraft.client.Options',
  OPTION_INSTANCE: 'net.minecraft.client.OptionInstance',
  WINDOW: 'com.mojang.blaze3d.platform.Window',
  SLOT: 'net.minecraft.world.entity.EquipmentSlot'
}

const NEEDS: Need[] = [
  { cls: C.MC, name: 'getInstance', argc: 0 },
  { cls: C.MC, name: 'getWindow', argc: 0 },
  { cls: C.MC, name: 'isWindowActive', argc: 0 },
  { cls: C.MC, name: 'getFps', argc: 0 },
  { cls: C.MC, name: 'player', field: true },
  { cls: C.MC, name: 'level', field: true },
  { cls: C.MC, name: 'options', field: true },
  { cls: C.MC, name: 'gameRenderer', field: true },
  { cls: C.MC, name: 'screen', field: true },
  { cls: C.MC, name: 'fps', field: true },
  { cls: C.ENTITY, name: 'getX', argc: 0 },
  { cls: C.ENTITY, name: 'getY', argc: 0 },
  { cls: C.ENTITY, name: 'getZ', argc: 0 },
  { cls: C.ENTITY, name: 'getYRot', argc: 0 },
  { cls: C.ENTITY, name: 'yRot', field: true },
  { cls: C.LIVING, name: 'getItemBySlot', argc: 1 },
  { cls: C.LIVING, name: 'getOffhandItem', argc: 0 },
  { cls: C.ITEM_ENTITY, name: 'getItem', argc: 0 },
  { cls: C.STACK, name: 'getCount', argc: 0 },
  { cls: C.STACK, name: 'getHoverName', argc: 0 },
  { cls: C.STACK, name: 'getDamageValue', argc: 0 },
  { cls: C.STACK, name: 'getMaxDamage', argc: 0 },
  { cls: C.STACK, name: 'isDamageableItem', argc: 0 },
  { cls: C.STACK, name: 'isEmpty', argc: 0 },
  { cls: C.STACK, name: 'getDescriptionId', argc: 0 },
  { cls: C.STACK, name: 'hasFoil', argc: 0 },
  { cls: C.STACK, name: 'getItem', argc: 0 },
  { cls: C.TEXT, name: 'getString', argc: 0 },
  { cls: C.COMPONENT, name: 'getString', argc: 0 },
  { cls: C.CLEVEL, name: 'entitiesForRendering', argc: 0 },
  { cls: C.LEVEL, name: 'getDayTime', argc: 0 },
  { cls: C.GAME_RENDERER, name: 'getMainCamera', argc: 0 },
  { cls: C.CAMERA, name: 'getPosition', argc: 0 },
  { cls: C.CAMERA, name: 'position', argc: 0 },
  { cls: C.CAMERA, name: 'getYRot', argc: 0 },
  { cls: C.CAMERA, name: 'getXRot', argc: 0 },
  { cls: C.VEC3, name: 'x', field: true },
  { cls: C.VEC3, name: 'y', field: true },
  { cls: C.VEC3, name: 'z', field: true },
  { cls: C.OPTIONS, name: 'fov', argc: 0 },
  { cls: C.OPTIONS, name: 'fov', field: true },
  { cls: C.OPTIONS, name: 'hideGui', field: true },
  { cls: C.OPTION_INSTANCE, name: 'get', argc: 0 },
  { cls: C.WINDOW, name: 'getX', argc: 0 },
  { cls: C.WINDOW, name: 'getY', argc: 0 },
  { cls: C.WINDOW, name: 'getScreenWidth', argc: 0 },
  { cls: C.WINDOW, name: 'getScreenHeight', argc: 0 },
  { cls: C.WINDOW, name: 'getGuiScale', argc: 0 },
  ...['HEAD', 'CHEST', 'LEGS', 'FEET'].map((n) => ({ cls: C.SLOT, name: n, field: true }))
]

// ---------------- ProGuard-маппинги Mojang ----------------

interface MojMethod {
  name: string
  params: string[]
  ret: string
  obf: string
}
interface MojClass {
  obf: string
  fields: Map<string, { obf: string; type: string }>
  methods: MojMethod[]
}

function parseProguard(text: string): Map<string, MojClass> {
  const classes = new Map<string, MojClass>()
  let cur: MojClass | null = null
  for (const raw of text.split('\n')) {
    if (!raw || raw.startsWith('#')) continue
    if (!raw.startsWith(' ')) {
      const m = /^(\S+) -> (\S+):/.exec(raw)
      if (m) {
        cur = { obf: m[2], fields: new Map(), methods: [] }
        classes.set(m[1], cur)
      }
      continue
    }
    if (!cur) continue
    const line = raw.trim().replace(/^\d+:\d+:/, '')
    const mm = /^(\S+) ([^\s(]+)\(([^)]*)\)(?::\d+:\d+)? -> (\S+)$/.exec(line)
    if (mm) {
      cur.methods.push({ ret: mm[1], name: mm[2], params: mm[3] ? mm[3].split(',') : [], obf: mm[4] })
      continue
    }
    const fm = /^(\S+) (\S+) -> (\S+)$/.exec(line)
    if (fm) cur.fields.set(fm[2], { type: fm[1], obf: fm[3] })
  }
  return classes
}

const PRIM: Record<string, string> = { int: 'I', long: 'J', float: 'F', double: 'D', boolean: 'Z', byte: 'B', char: 'C', short: 'S', void: 'V' }

/** Тип Mojang → JVM-дескриптор в обфусцированных именах. */
function obfDesc(type: string, classes: Map<string, MojClass>): string {
  let dims = ''
  let t = type
  while (t.endsWith('[]')) {
    dims += '['
    t = t.slice(0, -2)
  }
  if (PRIM[t]) return dims + PRIM[t]
  const obf = classes.get(t)?.obf || t
  return `${dims}L${obf.replace(/\./g, '/')};`
}

// ---------------- Intermediary (Fabric/Quilt) и SRG (Forge) ----------------

interface MemberTable {
  classes: Map<string, string>
  methods: Map<string, string>
  fields: Map<string, string>
}

function parseTiny(text: string): MemberTable {
  const t: MemberTable = { classes: new Map(), methods: new Map(), fields: new Map() }
  const lines = text.split(/\r?\n/)
  const v2 = lines[0]?.startsWith('tiny\t2')
  let cls = ''
  for (const l of lines.slice(1)) {
    const p = l.split('\t')
    if (v2) {
      if (p[0] === 'c') {
        cls = p[1]
        t.classes.set(p[1], p[2])
      } else if (p[1] === 'm') t.methods.set(`${cls}.${p[3]}${p[2]}`, p[4])
      else if (p[1] === 'f') t.fields.set(`${cls}.${p[3]}`, p[4])
    } else {
      if (p[0] === 'CLASS') t.classes.set(p[1], p[2])
      else if (p[0] === 'METHOD') t.methods.set(`${p[1]}.${p[3]}${p[2]}`, p[4])
      else if (p[0] === 'FIELD') t.fields.set(`${p[1]}.${p[3]}`, p[4])
    }
  }
  return t
}

function parseTsrg(text: string): MemberTable {
  const t: MemberTable = { classes: new Map(), methods: new Map(), fields: new Map() }
  let cls = ''
  for (const l of text.split(/\r?\n/)) {
    if (!l || l.startsWith('tsrg2')) continue
    if (!l.startsWith('\t')) {
      const p = l.split(' ')
      cls = p[0]
      t.classes.set(p[0], p[1])
      continue
    }
    if (l.startsWith('\t\t')) continue // параметры/статик-маркеры
    const p = l.trim().split(' ')
    if (p[1]?.startsWith('(')) t.methods.set(`${cls}.${p[0]}${p[1]}`, p[2])
    else t.fields.set(`${cls}.${p[0]}`, p[1])
  }
  return t
}

// ---------------- Сборка файла маппингов ----------------

type Namespace = 'mojang' | 'official' | 'intermediary' | 'srg'

export function overlayNamespace(inst: Instance, v: ResolvedVersion): Namespace | null {
  const mc = inst.mcVersion
  const unobf = /^\d{2}\./.test(mc) && !v.downloads?.client_mappings
  if (inst.loader === 'fabric' || inst.loader === 'quilt') return unobf ? 'mojang' : 'intermediary'
  if (unobf) return 'mojang'
  if (inst.loader === 'neoforge') return compareMc(mc, '1.20.5') >= 0 || /^\d{2}\./.test(mc) ? 'mojang' : 'srg'
  if (inst.loader === 'forge') {
    if (compareMc(mc, '1.20.6') >= 0 || /^\d{2}\./.test(mc)) return 'mojang'
    return compareMc(mc, '1.17') >= 0 ? 'srg' : null
  }
  return v.downloads?.client_mappings ? 'official' : null
}

function findLibrary(prefix: string[], fileRe: RegExp): string | null {
  const base = path.join(dirs.libraries(), ...prefix)
  if (!exists(base)) return null
  for (const ver of fs.readdirSync(base)) {
    const dir = path.join(base, ver)
    if (!fs.statSync(dir).isDirectory()) continue
    for (const f of fs.readdirSync(dir)) if (fileRe.test(f)) return path.join(dir, f)
  }
  return null
}

/** Готовит файл маппингов для агента. Возвращает путь или null, если версия не поддерживается. */
export async function buildOverlayMappings(inst: Instance, v: ResolvedVersion): Promise<{ file: string; ns: Namespace } | null> {
  const ns = overlayNamespace(inst, v)
  if (!ns) return null
  const out = path.join(ensureDir(path.join(dirs.cache(), 'overlay')), `${v.id}-${ns}-v2.tsv`)
  if (exists(out)) return { file: out, ns }

  const lines: string[] = []
  if (ns === 'mojang') {
    fs.writeFileSync(out, '')
    return { file: out, ns }
  }

  const cm = v.downloads?.client_mappings
  if (!cm?.url) return null
  const mojFile = path.join(dirs.versions(), v.rootId, 'client-mappings.txt')
  if (!exists(mojFile)) await downloadFile({ url: cm.url, path: mojFile, sha1: cm.sha1, size: cm.size })
  const moj = parseProguard(await fs.promises.readFile(mojFile, 'utf8'))

  let table: MemberTable | null = null
  if (ns === 'intermediary') {
    const jar = path.join(dirs.libraries(), ...mavenPath(`net.fabricmc:intermediary:${inst.mcVersion}`).split('/'))
    const alt = findLibrary(['net', 'fabricmc', 'intermediary'], new RegExp(`^intermediary-${inst.mcVersion.replace(/\./g, '\\.')}.*\\.jar$`))
    const file = exists(jar) ? jar : alt
    if (!file) return null
    table = parseTiny((await readZipText(file, 'mappings/mappings.tiny')) || '')
  } else if (ns === 'srg') {
    const zip = findLibrary(['de', 'oceanlabs', 'mcp', 'mcp_config'], new RegExp(`^mcp_config-${inst.mcVersion.replace(/\./g, '\\.')}-.*\\.zip$`))
    if (!zip) return null
    table = parseTsrg((await readZipText(zip, 'config/joined.tsrg')) || '')
  }

  for (const need of NEEDS) {
    const c = moj.get(need.cls)
    if (!c) continue
    const runtimeClass = ns === 'official' ? c.obf : ns === 'intermediary' ? (table!.classes.get(c.obf.replace(/\./g, '/')) || c.obf).replace(/\//g, '.') : need.cls
    lines.push(`C\t${need.cls}\t${runtimeClass}`)
    const owner = c.obf.replace(/\./g, '/')
    if (need.field) {
      const f = c.fields.get(need.name)
      if (!f) continue
      const name = ns === 'official' ? f.obf : table!.fields.get(`${owner}.${f.obf}`) || f.obf
      lines.push(`M\t${need.cls}#${need.name}\t${name}`)
    } else {
      const m = c.methods.find((x) => x.name === need.name && x.params.length === need.argc)
      if (!m) continue
      const desc = `(${m.params.map((p) => obfDesc(p, moj)).join('')})${obfDesc(m.ret, moj)}`
      const name = ns === 'official' ? m.obf : table!.methods.get(`${owner}.${m.obf}${desc}`) || m.obf
      lines.push(`M\t${need.cls}#${need.name}#${need.argc}\t${name}`)
    }
  }
  fs.writeFileSync(out, [...new Set(lines)].join('\n'))
  return { file: out, ns }
}
