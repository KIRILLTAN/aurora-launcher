import fs from 'fs'
import path from 'path'
import { exists } from '../util/store'
import type yauzl from 'yauzl'
import { entryBuffer, openZip } from '../util/zip'

/*
 * Иконки предметов для оверлея — так же, как их строит игра: через описание предмета
 * (items/<id>.json, 1.21.4+) и модель (models/item/<id>.json с родителями).
 * Плоские предметы — картинка layer0, блоки — текстуры граней, из которых оверлей рисует кубик.
 */

/** Иконка: плоская картинка или текстуры граней блока. */
export interface IconDef {
  flat?: string
  top?: string
  side?: string
  front?: string
  /** подкраска (листва, трава — в игре их красит биом): для плоской иконки и для граней блока */
  tint?: string
  tintTop?: string
  tintSide?: string
}

/** Ресурсы сборки: путь внутри jar → jar. Строится один раз по оглавлениям jar-файлов. */
type Ref = { zip: yauzl.ZipFile; entry: yauzl.Entry }

export class AssetIndex {
  // jar-файлы остаются открытыми, а записи запоминаются: чтение файла — сразу, без обхода оглавления
  private map: Promise<Map<string, Ref>>
  private zips: yauzl.ZipFile[] = []
  private json = new Map<string, Promise<Record<string, unknown> | null>>()
  private icons = new Map<string, Promise<IconDef | null>>()

  constructor(jars: string[], modsDir?: string) {
    this.map = (async () => {
      const all = [...jars]
      if (modsDir && exists(modsDir)) for (const f of await fs.promises.readdir(modsDir)) if (f.endsWith('.jar')) all.push(path.join(modsDir, f))
      const map = new Map<string, Ref>()
      for (const jar of all) {
        if (!exists(jar)) continue
        const zip = await openZip(jar).catch(() => null)
        if (!zip) continue
        this.zips.push(zip)
        await new Promise<void>((resolve) => {
          zip.on('entry', (e: yauzl.Entry) => {
            const n = e.fileName
            if (n.startsWith('assets/') && !map.has(n) && ((n.endsWith('.png') && n.includes('/textures/')) || (n.endsWith('.json') && (n.includes('/models/') || n.includes('/items/'))))) {
              map.set(n, { zip, entry: e })
            }
            zip.readEntry()
          })
          zip.on('end', () => resolve())
          zip.on('error', () => resolve())
          zip.readEntry()
        })
      }
      return map
    })()
  }

  icon(descriptionId: string): Promise<IconDef | null> {
    let p = this.icons.get(descriptionId)
    if (!p) {
      p = this.find(descriptionId).catch(() => null)
      this.icons.set(descriptionId, p)
    }
    return p
  }

  private async buf(entry: string): Promise<Buffer | null> {
    const ref = (await this.map).get(entry)
    return ref ? entryBuffer(ref.zip, ref.entry).catch(() => null) : null
  }

  /** Закрыть jar-файлы (игра закрыта). */
  close(): void {
    for (const z of this.zips) {
      try {
        z.close()
      } catch {
        /* уже закрыт */
      }
    }
    this.zips = []
  }

  private readJson(entry: string): Promise<Record<string, unknown> | null> {
    let p = this.json.get(entry)
    if (!p) {
      p = this.buf(entry).then((b) => {
        try {
          return b ? (JSON.parse(b.toString('utf8')) as Record<string, unknown>) : null
        } catch {
          return null
        }
      })
      this.json.set(entry, p)
    }
    return p
  }

  private async png(ref: string | undefined): Promise<string | undefined> {
    if (!ref) return undefined
    const [ns, p] = split(ref)
    const b = await this.buf(`assets/${ns}/textures/${p}.png`)
    return b ? 'data:image/png;base64,' + b.toString('base64') : undefined
  }

  /** Модель с текстурами, унаследованными от родителей. */
  private async model(ref: string, depth = 0): Promise<{ textures: Record<string, string>; chain: string[] } | null> {
    if (depth > 12) return null
    const [ns, p] = split(ref)
    const id = `${ns}:${p}`
    const j = await this.readJson(`assets/${ns}/models/${p}.json`)
    // встроенные модели игры (builtin/generated, block/block…) в jar лежат не всегда
    if (!j) return depth === 0 ? null : { textures: {}, chain: [id] }
    const parent = typeof j.parent === 'string' ? await this.model(j.parent, depth + 1) : null
    const textures: Record<string, string> = { ...(parent?.textures || {}) }
    for (const [k, raw] of Object.entries((j.textures || {}) as Record<string, unknown>)) {
      // 26.x: текстура может быть объектом { "sprite": "minecraft:block/glass", "force_translucent": true }
      const v = typeof raw === 'string' ? raw : raw && typeof raw === 'object' && typeof (raw as { sprite?: unknown }).sprite === 'string' ? (raw as { sprite: string }).sprite : null
      if (v) textures[k] = v.startsWith('#') || v.includes(':') ? v : `${ns}:${v}`
    }
    return { textures, chain: [id, ...(parent?.chain || [])] }
  }

  private async find(descriptionId: string): Promise<IconDef | null> {
    // форматы: "item.minecraft.diamond", "block.minecraft.stone" или "minecraft:diamond"
    const colon = /^([a-z0-9_.-]+):([a-z0-9_/.-]+)$/.exec(descriptionId)
    const m = colon ? ['', 'item', colon[1], colon[2]] : /^(item|block)\.([^.]+)\.(.+)$/.exec(descriptionId)
    if (!m) return null
    const [, kind, ns, rawPath] = m
    // у зелий и т.п. в id есть «хвост»: item.minecraft.potion.effect.swiftness → potion
    const names = [...new Set([rawPath.replace(/\./g, '/'), rawPath.split('.')[0]])]
    for (const p of names) {
      const refs: string[] = []
      const def = await this.readJson(`assets/${ns}/items/${p}.json`)
      const fm = def && firstModel(def.model ?? def)
      if (fm) refs.push(fm)
      refs.push(`${ns}:item/${p}`, `${ns}:block/${p}`)
      for (const ref of refs) {
        const icon = await this.fromModel(ref)
        if (icon) return icon
      }
    }
    // запасной вариант: угадываем имя текстуры
    const p = rawPath.replace(/\./g, '/')
    const guesses = kind === 'item'
      ? [`item/${p}`, `block/${p}`, `items/${p}`]
      : [`block/${p}`, `item/${p}`, `block/${p}_top`, `block/${p}_side`, `blocks/${p}`]
    for (const g of guesses) {
      const flat = await this.png(`${ns}:${g}`)
      if (flat) return { flat }
    }
    return null
  }

  private async fromModel(ref: string): Promise<IconDef | null> {
    const md = await this.model(ref)
    if (!md) return null
    const tex = (...keys: string[]): string | undefined => {
      for (const k of keys) {
        let v = md.textures[k]
        for (let i = 0; i < 8 && v?.startsWith('#'); i++) v = md.textures[v.slice(1)]
        if (v && !v.startsWith('#')) return v
      }
      return undefined
    }
    const flatModel = md.chain.some((c) => /^minecraft:(item\/generated|item\/handheld|builtin\/generated)/.test(c)) || !!md.textures.layer0
    if (flatModel) {
      const t = tex('layer0')
      const flat = await this.png(t)
      if (flat) return { flat, tint: tintFor(t) }
    }
    // растения (cross): плоская картинка
    if (md.chain.some((c) => /block\/(cross|tinted_cross|flower_pot_cross|crop)/.test(c))) {
      const t = tex('cross', 'plant', 'crop', 'particle')
      const flat = await this.png(t)
      if (flat) return { flat, tint: tintFor(t) }
    }
    // блок: кубик из граней
    const topRef = tex('top', 'end', 'up', 'all', 'texture', 'pattern', 'wool', 'particle')
    const sideRef = tex('side', 'all', 'north', 'south', 'east', 'texture', 'pattern', 'wool', 'front', 'particle')
    const frontRef = tex('front', 'north', 'south', 'side', 'all', 'texture', 'pattern', 'wool', 'particle')
    const [top, side, front] = await Promise.all([this.png(topRef), this.png(sideRef), this.png(frontRef)])
    if (top || side) {
      const tTop = tintFor(topRef || sideRef)
      const tSide = tintFor(sideRef || topRef)
      return { top: top || side, side: side || top, front: front || side || top, tintTop: tTop, tintSide: tSide }
    }
    const particle = await this.png(tex('particle'))
    return particle ? { flat: particle } : null
  }
}

function split(ref: string): [string, string] {
  const i = ref.indexOf(':')
  return i >= 0 ? [ref.slice(0, i), ref.slice(i + 1)] : ['minecraft', ref]
}

/** Первая ссылка на модель в описании предмета 1.21.4+ (условия, выборы и т.п. — берём первый вариант). */
function firstModel(o: unknown): string | null {
  if (!o || typeof o !== 'object') return null
  const r = o as Record<string, unknown>
  if (typeof r.model === 'string') return r.model
  for (const v of Object.values(r)) {
    const f = Array.isArray(v) ? v.map(firstModel).find(Boolean) || null : firstModel(v)
    if (f) return f
  }
  return null
}

/** Подкраска как у биома «равнины»: листва, трава, лианы. */
function tintFor(ref: string | undefined): string | undefined {
  if (!ref) return undefined
  if (/spruce_leaves/.test(ref)) return '#619961'
  if (/birch_leaves/.test(ref)) return '#80a755'
  if (/(cherry|azalea|pale_oak|flowering)/.test(ref)) return undefined
  if (/(_leaves|grass_block_top|short_grass|tall_grass|\/grass$|fern|vine|lily_pad|sugar_cane)/.test(ref)) return '#5fa040'
  return undefined
}
