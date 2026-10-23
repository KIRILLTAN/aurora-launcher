import type { OverlayConfig } from '@shared/types'
import './overlay.css'

/* Прозрачный оверлей поверх окна Minecraft. Данные приходят от Java-агента ~60 раз в секунду. */

interface Stack {
  id: string
  n: string
  c: number
  d?: number
  md?: number
  g?: number
}
interface Snap {
  win?: number[]
  inGame?: boolean
  screen?: boolean
  hideGui?: boolean
  fps?: number
  pos?: number[]
  cam?: number[]
  fov?: number
  time?: number
  armor?: (Stack | null)[]
  main?: Stack | null
  off?: Stack | null
  loot?: { p: number[]; i: Stack | null }[]
}
interface MenuState {
  index: number
  items: { key: keyof OverlayConfig | 'close'; label: string }[]
}
interface IconDef {
  flat?: string
  top?: string
  side?: string
  front?: string
  tint?: string
  tintTop?: string
  tintSide?: string
}

const world = document.getElementById('world')!
const hud = document.getElementById('hud')!
let snap: Snap = {}
let cfg: OverlayConfig | null = null
let menu: MenuState | null = null
let scheduled = false
const icons = new Map<string, string>()
const pending = new Set<string>()

window.aurora.on('overlay:data', (line) => {
  try {
    snap = JSON.parse(line as string) as Snap
  } catch {
    return
  }
  schedule()
})
window.aurora.on('overlay:config', (p) => {
  const payload = p as { config: OverlayConfig; menu: MenuState | null }
  cfg = payload.config
  menu = payload.menu
  lastHud = ''
  schedule()
})

function frame(): void {
  if (!scheduled) return
  scheduled = false
  render()
  // кадр готов — лаунчер пришлёт следующий снимок (без очереди и отставания)
  window.aurora.overlayAck()
}

function schedule(): void {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(frame)
  // Windows может притормаживать requestAnimationFrame у окна поверх игры — не ждём его дольше кадра
  setTimeout(frame, 20)
}

function icon(id: string): string {
  const c = icons.get(id)
  if (c !== undefined) return c
  if (!pending.has(id)) {
    pending.add(id)
    window.aurora
      .invoke('overlay:icon', id)
      .then((def) => renderIcon(def as IconDef | null))
      .then((url) => {
        icons.set(id, url)
        lastHud = ''
        for (const el of pool) el.dataset.k = ''
        schedule()
      })
      .catch(() => icons.set(id, ''))
  }
  return ''
}

// ---------- Иконки: картинка предмета или кубик блока, как в инвентаре ----------
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = src
  })
}

/** Квадрат текстуры (у анимированных — первый кадр), при необходимости подкрашенный. */
function face(img: HTMLImageElement, tint?: string): HTMLCanvasElement {
  const t = img.width
  const c = document.createElement('canvas')
  c.width = c.height = t
  const g = c.getContext('2d')!
  g.imageSmoothingEnabled = false
  g.drawImage(img, 0, 0, t, t, 0, 0, t, t)
  if (tint) {
    g.globalCompositeOperation = 'multiply'
    g.fillStyle = tint
    g.fillRect(0, 0, t, t)
    g.globalCompositeOperation = 'destination-in'
    g.drawImage(img, 0, 0, t, t, 0, 0, t, t)
  }
  return c
}

async function renderIcon(def: IconDef | null): Promise<string> {
  if (!def) return ''
  if (def.flat) {
    const f = face(await loadImage(def.flat), def.tint)
    return f.toDataURL()
  }
  if (!def.top || !def.side) return ''
  const [top, side, front] = await Promise.all([loadImage(def.top), loadImage(def.side), loadImage(def.front || def.side)])
  const S = 64
  const c = document.createElement('canvas')
  c.width = c.height = S
  const g = c.getContext('2d')!
  g.imageSmoothingEnabled = false
  // изометрический кубик: верх, левая (лицевая) и правая грани
  const draw = (src: HTMLCanvasElement, a: number, b: number, cc: number, d: number, e: number, f: number, shade: number): void => {
    const t = src.width
    g.setTransform(a / t, b / t, cc / t, d / t, e, f)
    g.drawImage(src, 0, 0)
    if (shade > 0) {
      g.globalCompositeOperation = 'source-atop'
      g.fillStyle = `rgba(0,0,0,${shade})`
      g.fillRect(0, 0, t, t)
      g.globalCompositeOperation = 'source-over'
    }
  }
  draw(face(top, def.tintTop), 28, -14, 28, 14, 4, 18, 0)
  draw(face(front, def.tintSide), 28, 14, 0, 30, 4, 18, 0.18)
  draw(face(side, def.tintSide), 28, -14, 0, 30, 32, 32, 0.38)
  g.setTransform(1, 0, 0, 1, 0, 0)
  return c.toDataURL()
}

const esc = (s: string): string => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!)

function iconHtml(st: Stack, size: number): string {
  const url = icon(st.id)
  const style = `width:${size}px;height:${size}px`
  if (!url) return `<span class="ic ph" style="${style}">${esc(st.n.slice(0, 1))}</span>`
  return `<span class="ic${st.g ? ' glint' : ''}" style="${style};background-image:url('${url}')"></span>`
}

function durability(st: Stack): { text: string; cls: string; pct: number } | null {
  if (!st.md) return null
  const left = st.md - (st.d || 0)
  const pct = left / st.md
  return { text: `${left}/${st.md}`, cls: pct > 0.6 ? 'ok' : pct > 0.3 ? 'warn' : 'bad', pct }
}

const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖']
function arrowTo(x: number, z: number): string {
  if (!snap.pos) return ''
  const [px, , pz, yaw] = snap.pos
  const target = (Math.atan2(-(x - px), z - pz) * 180) / Math.PI
  let rel = ((target - yaw) % 360 + 540) % 360 - 180
  if (!isFinite(rel)) rel = 0
  return ARROWS[((Math.round(rel / 45) % 8) + 8) % 8]
}

// ---------- Проекция мировых координат на экран ----------
function project(x: number, y: number, z: number): { sx: number; sy: number; depth: number } | null {
  const cam = snap.cam
  if (!cam) return null
  const [cx, cy, cz, yawDeg, pitchDeg] = cam
  const yaw = (yawDeg * Math.PI) / 180
  const pitch = (pitchDeg * Math.PI) / 180
  const fx = -Math.sin(yaw) * Math.cos(pitch)
  const fy = -Math.sin(pitch)
  const fz = Math.cos(yaw) * Math.cos(pitch)
  const rx = -Math.cos(yaw)
  const rz = -Math.sin(yaw)
  // up = right × forward
  const ux = -rz * fy
  const uy = rz * fx - rx * fz
  const uz = rx * fy
  const dx = x - cx
  const dy = y - cy
  const dz = z - cz
  const depth = dx * fx + dy * fy + dz * fz
  if (depth < 0.1) return null
  const vx = dx * rx + dz * rz
  const vy = dx * ux + dy * uy + dz * uz
  const W = window.innerWidth
  const H = window.innerHeight
  const t = Math.tan((((snap.fov || 70) * Math.PI) / 180) / 2)
  const ndcX = vx / (depth * t * (W / H))
  const ndcY = vy / (depth * t)
  if (Math.abs(ndcX) > 1.2 || Math.abs(ndcY) > 1.2) return null
  return { sx: ((ndcX + 1) / 2) * W, sy: ((1 - ndcY) / 2) * H, depth }
}

// пул элементов для иконок в мире — без пересоздания DOM каждый кадр
const pool: HTMLDivElement[] = []
function worldIcon(i: number): HTMLDivElement {
  while (pool.length <= i) {
    const el = document.createElement('div')
    el.className = 'wi'
    world.appendChild(el)
    pool.push(el)
  }
  return pool[i]
}

let lastHud = ''

function render(): void {
  const show = !!cfg && snap.inGame && !snap.hideGui
  // --- иконки над лутом
  let used = 0
  if (show && cfg!.worldIcons && !snap.screen && snap.loot) {
    // одинаковые предметы, лежащие рядом, — одна иконка с общим числом
    const piles: { p: number[]; i: Stack }[] = []
    for (const l of snap.loot) {
      if (!l.i) continue
      if (snap.pos) {
        const d = Math.hypot(l.p[0] - snap.pos[0], l.p[1] - snap.pos[1], l.p[2] - snap.pos[2])
        if (d > cfg!.radius) continue
      }
      const near = piles.find((q) => q.i.id === l.i!.id && Math.abs(q.p[0] - l.p[0]) < 1.2 && Math.abs(q.p[1] - l.p[1]) < 1.2 && Math.abs(q.p[2] - l.p[2]) < 1.2)
      if (near) near.i = { ...near.i, c: near.i.c + l.i.c }
      else piles.push({ p: l.p, i: l.i })
    }
    for (const l of piles) {
      const pr = project(l.p[0], l.p[1] + 0.75, l.p[2])
      if (!pr) continue
      const size = Math.max(14, Math.min(40, 120 / Math.max(1, pr.depth)))
      const el = worldIcon(used++)
      const html = iconHtml(l.i, size) + (l.i.c > 1 ? `<b>${l.i.c}</b>` : '')
      if (el.dataset.k !== html) {
        el.innerHTML = html
        el.dataset.k = html
      }
      el.style.transform = `translate(${pr.sx - size / 2}px, ${pr.sy - size}px)`
      el.style.display = 'block'
      el.style.opacity = String(Math.max(0.45, 1 - pr.depth / (cfg!.radius * 1.4)))
    }
  }
  for (let i = used; i < pool.length; i++) pool[i].style.display = 'none'

  // --- панели HUD (перестраиваем только при изменениях)
  const parts: string[] = []
  if (show && !snap.screen) {
    const c = cfg!
    const info: string[] = []
    if (c.coords && snap.pos) {
      const dirs = ['Юг', 'Юго-запад', 'Запад', 'Северо-запад', 'Север', 'Северо-восток', 'Восток', 'Юго-восток']
      const face = dirs[((Math.round((((snap.pos[3] % 360) + 360) % 360) / 45) % 8) + 8) % 8]
      info.push(`XYZ: ${Math.floor(snap.pos[0])} ${Math.floor(snap.pos[1])} ${Math.floor(snap.pos[2])} · ${face}`)
    }
    if (c.fps && snap.fps !== undefined) info.push(`${snap.fps} FPS`)
    if (c.clock && snap.time !== undefined) {
      const t = (snap.time + 6000) % 24000
      info.push(`Время ${String(Math.floor(t / 1000)).padStart(2, '0')}:${String(Math.floor(((t % 1000) * 60) / 1000)).padStart(2, '0')} · день ${Math.floor(snap.time / 24000) + 1}`)
    }
    let lootHtml = ''
    if (c.loot && snap.loot && snap.pos) {
      const groups = new Map<string, { st: Stack; count: number; d: number; x: number; z: number }>()
      for (const l of snap.loot) {
        if (!l.i) continue
        const d = Math.hypot(l.p[0] - snap.pos[0], l.p[1] - snap.pos[1], l.p[2] - snap.pos[2])
        if (d > c.radius) continue
        const g = groups.get(l.i.n)
        if (g) g.count += l.i.c
        else groups.set(l.i.n, { st: l.i, count: l.i.c, d, x: l.p[0], z: l.p[2] })
      }
      const rows = [...groups.values()].slice(0, c.maxLines)
      lootHtml = `<div class="title">Лут рядом: ${groups.size}</div>` + (rows.length
        ? rows.map((g) => `<div class="row">${iconHtml(g.st, 18)}<span class="${g.st.g ? 'gold' : ''}">${esc(g.st.n)}${g.count > 1 ? ' ×' + g.count : ''}</span><span class="dim">${Math.round(g.d)}м${c.arrows ? ' ' + arrowTo(g.x, g.z) : ''}</span></div>`).join('')
        : `<div class="dim">ничего в радиусе ${c.radius} бл.</div>`)
    }
    if (info.length || lootHtml) {
      parts.push(`<div class="panel ${c.rightSide ? 'right' : 'left'}">${info.map((s) => `<div>${esc(s)}</div>`).join('')}${lootHtml}</div>`)
    }
    // броня — справа от хотбара, левая рука — слева
    const scale = snap.win && snap.win[2] ? (window.innerWidth / snap.win[2]) * (snap.win[4] || 2) : 2
    const half = 91 * scale
    if (c.armor && snap.armor) {
      const items = snap.armor.filter((a): a is Stack => !!a)
      if (items.length) {
        parts.push(`<div class="equip armor" style="left:calc(50% + ${half + 8}px)">${items.map((a) => {
          const dur = durability(a)
          return `<div class="row">${iconHtml(a, 20)}<span class="${dur?.cls || ''}">${dur ? dur.text : a.c > 1 ? '×' + a.c : ''}</span></div>`
        }).join('')}</div>`)
      }
    }
    // предметы в руках с прочностью — слева от хотбара
    if (c.offhand && (snap.main || snap.off)) {
      const row = (st: Stack, hand: string): string => {
        const dur = durability(st)
        const shield = /shield/.test(st.id)
        const name = shield ? 'Щит' : esc(st.n)
        const bar = dur ? `<span class="bar"><i class="${dur.cls}" style="width:${Math.round(dur.pct * 100)}%"></i></span>` : ''
        return `<div class="row">${iconHtml(st, 24)}<span><span class="dim small">${hand}</span> <span class="${shield ? 'accent' : st.g ? 'gold' : ''}">${name}</span><br><span class="${dur?.cls || 'dim'}">${dur ? dur.text : st.c > 1 ? '×' + st.c : ''}</span>${bar}</span></div>`
      }
      const rows = (snap.main ? [row(snap.main, 'правая')] : []).concat(snap.off ? [row(snap.off, 'левая')] : [])
      parts.push(`<div class="equip off" style="right:calc(50% + ${half + 29 * scale + 8}px)">${rows.join('')}</div>`)
    }
  }
  if (menu && cfg) {
    const c = cfg
    parts.push(`<div class="menu"><div class="mtitle">✦ Aurora Helper ✦</div><div class="mhint">F6 или Esc — закрыть · ↑↓ выбор · ←→/Enter изменить</div>${menu.items.map((it, i) => {
      if (it.key === 'close') return `<div class="mi close${i === menu!.index ? ' sel' : ''}"><span>${it.label}</span><span class="dim">Enter</span></div>`
      const v = c[it.key]
      const val = typeof v === 'boolean' ? (v ? '<span class="ok">ВКЛ</span>' : '<span class="dim">выкл</span>') : `<span class="accent">${v}</span>`
      return `<div class="mi${i === menu!.index ? ' sel' : ''}"><span>${it.label}</span>${val}</div>`
    }).join('')}</div>`)
  }
  const html = parts.join('')
  if (html !== lastHud) {
    hud.innerHTML = html
    lastHud = html
  }
}
