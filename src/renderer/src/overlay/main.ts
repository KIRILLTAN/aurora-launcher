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
  off?: Stack | null
  loot?: { p: number[]; i: Stack | null }[]
}
interface MenuState {
  index: number
  items: { key: keyof OverlayConfig; label: string }[]
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
    window.aurora.invoke('overlay:icon', id).then((url) => {
      icons.set(id, (url as string) || '')
      lastHud = ''
      schedule()
    }).catch(() => icons.set(id, ''))
  }
  return ''
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
    for (const l of snap.loot) {
      if (!l.i) continue
      if (snap.pos) {
        const d = Math.hypot(l.p[0] - snap.pos[0], l.p[1] - snap.pos[1], l.p[2] - snap.pos[2])
        if (d > cfg!.radius) continue
      }
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
    if (c.offhand && snap.off) {
      const o = snap.off
      const dur = durability(o)
      const shield = /shield/.test(o.id)
      parts.push(`<div class="equip off" style="right:calc(50% + ${half + 29 * scale + 8}px)"><div class="row">${iconHtml(o, 24)}<span><span class="${shield ? 'accent' : ''}">${shield ? 'Щит' : esc(o.n)}</span><br><span class="${dur?.cls || 'dim'}">${dur ? dur.text : o.c > 1 ? '×' + o.c : ''}</span></span></div></div>`)
    }
  }
  if (menu && cfg) {
    const c = cfg
    parts.push(`<div class="menu"><div class="mtitle">✦ Aurora Helper ✦</div><div class="mhint">F6 — закрыть · ↑↓ выбор · ←→/Enter изменить</div>${menu.items.map((it, i) => {
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
