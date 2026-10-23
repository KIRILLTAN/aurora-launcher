import { useCallback, useEffect, useRef, useState } from 'react'
import { SkinViewer, WalkingAnimation, IdleAnimation } from 'skinview3d'
import { Pencil, Eraser, PaintBucket, Pipette, Undo2, Redo2, Upload, Download, Save, Grid3x3, Layers, Sun, Moon, RotateCcw, UserRound, CloudUpload, Trash2, FolderOpen, Play, Pause, FlipHorizontal } from 'lucide-react'
import { api, type SavedSkin } from '../api'
import { useStore } from '../store'
import { Spinner } from '../components/ui'

type Tool = 'pencil' | 'eraser' | 'fill' | 'picker' | 'lighten' | 'darken'
type Layer = 'base' | 'overlay' | 'both'

const SCALE = 8
const PALETTE = [
  '#000000', '#3b3b3b', '#7a7a7a', '#bdbdbd', '#ffffff', '#5c3a21', '#8b5a2b', '#c68642', '#e0ac69', '#f1c27d',
  '#b71c1c', '#e53935', '#ff7043', '#ffb300', '#fdd835', '#2e7d32', '#43a047', '#7cb342', '#00897b', '#26c6da',
  '#1565c0', '#1e88e5', '#3949ab', '#5e35b1', '#8e24aa', '#d81b60', '#f06292', '#3dffb0', '#38c6ff', '#a477ff'
]

// [x, y, w, h] — области развёртки скина 64×64
const BASE: number[][] = [[0, 0, 32, 16], [16, 16, 24, 16], [40, 16, 16, 16], [0, 16, 16, 16], [16, 48, 16, 16], [32, 48, 16, 16]]
const OVERLAY: number[][] = [[32, 0, 32, 16], [16, 32, 24, 16], [40, 32, 16, 16], [0, 32, 16, 16], [0, 48, 16, 16], [48, 48, 16, 16]]
const inRects = (rects: number[][], x: number, y: number): boolean => rects.some(([rx, ry, w, h]) => x >= rx && x < rx + w && y >= ry && y < ry + h)
const SLIM_HIDDEN = [[50, 16, 2, 4], [54, 20, 2, 12], [42, 48, 2, 4], [46, 52, 2, 12], [50, 32, 2, 4], [54, 36, 2, 12], [58, 48, 2, 4], [62, 52, 2, 12]]

interface Box {
  ox: number
  oy: number
  w: number
  h: number
  d: number
}
type Face = 'top' | 'bottom' | 'right' | 'front' | 'left' | 'back'
const FACES: Face[] = ['top', 'bottom', 'right', 'front', 'left', 'back']
/** Прямоугольник грани кубоида в стандартной развёртке Minecraft. */
function faceRect(b: Box, f: Face): [number, number, number, number] {
  switch (f) {
    case 'top': return [b.ox + b.d, b.oy, b.w, b.d]
    case 'bottom': return [b.ox + b.d + b.w, b.oy, b.w, b.d]
    case 'right': return [b.ox, b.oy + b.d, b.d, b.h]
    case 'front': return [b.ox + b.d, b.oy + b.d, b.w, b.h]
    case 'left': return [b.ox + b.d + b.w, b.oy + b.d, b.d, b.h]
    case 'back': return [b.ox + 2 * b.d + b.w, b.oy + b.d, b.w, b.h]
  }
}

/** Процедурный стартовый скин (свой, без ассетов Mojang). */
function generateDefault(): ImageData {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const r = (col: string, x: number, y: number, w: number, h: number): void => {
    g.fillStyle = col
    g.fillRect(x, y, w, h)
  }
  const skin = '#d9a77c', hair = '#2c1b12', shirt = '#2a9df4', shirt2 = '#1f7ed0', pants = '#28305e', shoes = '#3a3a3a'
  // голова
  r(skin, 0, 8, 32, 8); r(skin, 8, 0, 16, 8)
  r(hair, 8, 0, 8, 8); r(hair, 0, 8, 32, 2); r(hair, 24, 8, 8, 8); r(hair, 0, 10, 2, 3); r(hair, 22, 10, 2, 3)
  r('#ffffff', 9, 12, 2, 1); r('#3d6bd9', 10, 12, 1, 1); r('#ffffff', 13, 12, 2, 1); r('#3d6bd9', 13, 12, 1, 1)
  r('#a86a4a', 11, 14, 2, 1); r('#7a4a34', 10, 15, 4, 1)
  // тело
  r(shirt, 16, 20, 24, 12); r(shirt, 20, 16, 16, 4); r(shirt2, 20, 20, 8, 1)
  // руки
  r(shirt, 40, 20, 16, 6); r(skin, 40, 26, 16, 6); r(shirt, 44, 16, 4, 4); r(skin, 48, 16, 4, 4)
  r(shirt, 32, 52, 16, 6); r(skin, 32, 58, 16, 6); r(shirt, 36, 48, 4, 4); r(skin, 40, 48, 4, 4)
  // ноги
  r(pants, 0, 20, 16, 9); r(shoes, 0, 29, 16, 3); r(pants, 4, 16, 8, 4)
  r(pants, 16, 52, 16, 9); r(shoes, 16, 61, 16, 3); r(pants, 20, 48, 8, 4)
  // куртка-накладка
  r('rgba(255,255,255,0.12)', 20, 36, 8, 12)
  return g.getImageData(0, 0, 64, 64)
}

function hexToRgba(hex: string): [number, number, number, number] {
  const n = parseInt(hex.slice(1), 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255]
}
function rgbaToHex(r: number, g: number, b: number): string {
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
}

export default function SkinsPage() {
  const { accounts, settings, toast } = useStore()
  const account = accounts.find((a) => a.id === settings?.selectedAccount) || accounts[0]
  const editRef = useRef<HTMLCanvasElement>(null)
  const viewRef = useRef<HTMLCanvasElement>(null)
  const viewer = useRef<SkinViewer | null>(null)
  const data = useRef<ImageData>(generateDefault())
  const undo = useRef<ImageData[]>([])
  const redo = useRef<ImageData[]>([])
  const drawing = useRef(false)
  const [, force] = useState(0)
  const [tool, setTool] = useState<Tool>('pencil')
  const [color, setColor] = useState('#38c6ff')
  const [layer, setLayer] = useState<Layer>('both')
  const [grid, setGrid] = useState(true)
  const [mirror, setMirror] = useState(false)
  const [slim, setSlim] = useState(false)
  const [walk, setWalk] = useState(true)
  const [name, setName] = useState('Мой скин')
  const [nick, setNick] = useState('')
  const [saved, setSaved] = useState<SavedSkin[]>([])
  const [busy, setBusy] = useState(false)

  const redraw = useCallback(() => {
    const c = editRef.current
    if (!c) return
    const g = c.getContext('2d')!
    g.imageSmoothingEnabled = false
    g.clearRect(0, 0, c.width, c.height)
    // неиспользуемые области
    g.fillStyle = 'rgba(0,0,0,0.35)'
    g.fillRect(0, 0, c.width, c.height)
    for (const [x, y, w, h] of [...BASE, ...OVERLAY]) {
      const active = layer === 'both' || (layer === 'base' ? inRects(BASE, x, y) : inRects(OVERLAY, x, y))
      g.fillStyle = active ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.015)'
      g.fillRect(x * SCALE, y * SCALE, w * SCALE, h * SCALE)
    }
    const tmp = document.createElement('canvas')
    tmp.width = tmp.height = 64
    tmp.getContext('2d')!.putImageData(data.current, 0, 0)
    g.drawImage(tmp, 0, 0, 64 * SCALE, 64 * SCALE)
    if (grid) {
      g.strokeStyle = 'rgba(255,255,255,0.06)'
      g.lineWidth = 1
      g.beginPath()
      for (let i = 0; i <= 64; i++) {
        g.moveTo(i * SCALE + 0.5, 0)
        g.lineTo(i * SCALE + 0.5, 64 * SCALE)
        g.moveTo(0, i * SCALE + 0.5)
        g.lineTo(64 * SCALE, i * SCALE + 0.5)
      }
      g.stroke()
      g.strokeStyle = 'rgba(56,198,255,0.35)'
      for (const [x, y, w, h] of [...BASE, ...OVERLAY]) g.strokeRect(x * SCALE + 0.5, y * SCALE + 0.5, w * SCALE, h * SCALE)
    }
    if (slim) {
      g.fillStyle = 'rgba(255,60,90,0.25)'
      for (const [x, y, w, h] of SLIM_HIDDEN) g.fillRect(x * SCALE, y * SCALE, w * SCALE, h * SCALE)
    }
  }, [grid, layer, slim])

  const toDataUrl = (): string => {
    const tmp = document.createElement('canvas')
    tmp.width = tmp.height = 64
    tmp.getContext('2d')!.putImageData(data.current, 0, 0)
    return tmp.toDataURL('image/png')
  }

  const updatePreview = useCallback(() => {
    viewer.current?.loadSkin(toDataUrl(), { model: slim ? 'slim' : 'default' })
  }, [slim])

  useEffect(() => {
    if (!viewRef.current) return
    const v = new SkinViewer({ canvas: viewRef.current, width: viewRef.current.clientWidth, height: 420 })
    v.zoom = 0.85
    v.autoRotate = true
    v.autoRotateSpeed = 0.6
    v.animation = new WalkingAnimation()
    viewer.current = v
    updatePreview()
    const onResize = (): void => v.setSize(viewRef.current!.clientWidth, 420)
    window.addEventListener('resize', onResize)
    api.savedSkins().then(setSaved)
    return () => {
      window.removeEventListener('resize', onResize)
      v.dispose()
    }
  }, [])
  useEffect(() => {
    if (viewer.current) viewer.current.animation = walk ? new WalkingAnimation() : new IdleAnimation()
  }, [walk])
  useEffect(() => {
    redraw()
    updatePreview()
  }, [redraw, updatePreview])

  const pushUndo = (): void => {
    undo.current.push(new ImageData(new Uint8ClampedArray(data.current.data), 64, 64))
    if (undo.current.length > 60) undo.current.shift()
    redo.current = []
  }
  const allowed = (x: number, y: number): boolean => {
    if (layer === 'base') return inRects(BASE, x, y)
    if (layer === 'overlay') return inRects(OVERLAY, x, y)
    return inRects(BASE, x, y) || inRects(OVERLAY, x, y)
  }

  /** Зеркальная точка: правая рука/нога ↔ левая (с разворотом каждой грани). */
  const mirrorPoint = (x: number, y: number): [number, number] | null => {
    const aw = slim ? 3 : 4
    const box = (ox: number, oy: number, w: number, h: number, d: number): Box => ({ ox, oy, w, h, d })
    const pairs: [Box, Box][] = [
      [box(0, 0, 8, 8, 8), box(0, 0, 8, 8, 8)],
      [box(32, 0, 8, 8, 8), box(32, 0, 8, 8, 8)],
      [box(16, 16, 8, 12, 4), box(16, 16, 8, 12, 4)],
      [box(16, 32, 8, 12, 4), box(16, 32, 8, 12, 4)],
      [box(40, 16, aw, 12, 4), box(32, 48, aw, 12, 4)],
      [box(40, 32, aw, 12, 4), box(48, 48, aw, 12, 4)],
      [box(0, 16, 4, 12, 4), box(16, 48, 4, 12, 4)],
      [box(0, 32, 4, 12, 4), box(0, 48, 4, 12, 4)]
    ]
    for (const [a, b] of pairs) {
      for (const [from, to] of [[a, b], [b, a]]) {
        for (const f of FACES) {
          const [fx0, fy0, fw, fh] = faceRect(from, f)
          if (x < fx0 || x >= fx0 + fw || y < fy0 || y >= fy0 + fh) continue
          const tf: Face = f === 'right' ? 'left' : f === 'left' ? 'right' : f
          const [tx0, ty0, tw] = faceRect(to, tf)
          return [tx0 + (tw - 1 - (x - fx0)), ty0 + (y - fy0)]
        }
      }
    }
    return null
  }

  const plot = (x: number, y: number): void => {
    if (!allowed(x, y)) return
    const d = data.current.data
    const i = (y * 64 + x) * 4
    if (tool === 'pencil') {
      const [r, g, b] = hexToRgba(color)
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255
    } else if (tool === 'eraser') {
      d[i + 3] = 0
    } else if (tool === 'lighten' || tool === 'darken') {
      if (d[i + 3] === 0) return
      const k = tool === 'lighten' ? 1.12 : 0.88
      d[i] = Math.min(255, d[i] * k + (tool === 'lighten' ? 4 : 0))
      d[i + 1] = Math.min(255, d[i + 1] * k + (tool === 'lighten' ? 4 : 0))
      d[i + 2] = Math.min(255, d[i + 2] * k + (tool === 'lighten' ? 4 : 0))
    }
  }

  const apply = (x: number, y: number): void => {
    if (tool === 'picker') {
      const d = data.current.data
      const i = (y * 64 + x) * 4
      if (d[i + 3]) setColor(rgbaToHex(d[i], d[i + 1], d[i + 2]))
      setTool('pencil')
      return
    }
    if (tool === 'fill') {
      floodFill(x, y)
      return
    }
    plot(x, y)
    if (mirror) {
      const m = mirrorPoint(x, y)
      if (m) plot(m[0], m[1])
    }
  }

  const floodFill = (sx: number, sy: number): void => {
    if (!allowed(sx, sy)) return
    const d = data.current.data
    const idx = (x: number, y: number): number => (y * 64 + x) * 4
    const s = idx(sx, sy)
    const target = [d[s], d[s + 1], d[s + 2], d[s + 3]]
    const [r, g, b] = hexToRgba(color)
    if (target[0] === r && target[1] === g && target[2] === b && target[3] === 255) return
    const stack = [[sx, sy]]
    const seen = new Set<number>()
    while (stack.length) {
      const [x, y] = stack.pop()!
      if (x < 0 || y < 0 || x >= 64 || y >= 64) continue
      const k = y * 64 + x
      if (seen.has(k) || !allowed(x, y)) continue
      seen.add(k)
      const i = k * 4
      if (d[i] !== target[0] || d[i + 1] !== target[1] || d[i + 2] !== target[2] || d[i + 3] !== target[3]) continue
      d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1])
    }
  }

  const pos = (e: React.PointerEvent): [number, number] => {
    const rect = editRef.current!.getBoundingClientRect()
    return [Math.floor(((e.clientX - rect.left) / rect.width) * 64), Math.floor(((e.clientY - rect.top) / rect.height) * 64)]
  }
  const lastPreview = useRef(0)
  const onDown = (e: React.PointerEvent): void => {
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
    pushUndo()
    drawing.current = true
    const [x, y] = pos(e)
    if (e.button === 2) plotEraser(x, y)
    else apply(x, y)
    redraw()
  }
  const plotEraser = (x: number, y: number): void => {
    if (!allowed(x, y)) return
    data.current.data[(y * 64 + x) * 4 + 3] = 0
  }
  const onMove = (e: React.PointerEvent): void => {
    if (!drawing.current || tool === 'fill' || tool === 'picker') return
    const [x, y] = pos(e)
    if (x < 0 || y < 0 || x >= 64 || y >= 64) return
    if (e.buttons === 2) plotEraser(x, y)
    else apply(x, y)
    redraw()
    if (Date.now() - lastPreview.current > 120) {
      lastPreview.current = Date.now()
      updatePreview()
    }
  }
  const onUp = (): void => {
    drawing.current = false
    updatePreview()
  }

  const doUndo = (): void => {
    const prev = undo.current.pop()
    if (!prev) return
    redo.current.push(data.current)
    data.current = prev
    redraw()
    updatePreview()
  }
  const doRedo = (): void => {
    const next = redo.current.pop()
    if (!next) return
    undo.current.push(data.current)
    data.current = next
    redraw()
    updatePreview()
  }

  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      if (e.ctrlKey && e.key.toLowerCase() === 'z') (e.shiftKey ? doRedo : doUndo)()
      else if (e.ctrlKey && e.key.toLowerCase() === 'y') doRedo()
      else if (e.key === 'b') setTool('pencil')
      else if (e.key === 'e') setTool('eraser')
      else if (e.key === 'g') setTool('fill')
      else if (e.key === 'i') setTool('picker')
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  })

  /** Загрузка картинки любого размера (64×32 старый формат конвертируется). */
  const loadImage = (src: string, isSlim?: boolean): Promise<void> =>
    new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => {
        const c = document.createElement('canvas')
        c.width = c.height = 64
        const g = c.getContext('2d')!
        g.imageSmoothingEnabled = false
        if (img.height === img.width / 2) {
          g.drawImage(img, 0, 0, 64, 32)
          // старый формат: копируем правую руку/ногу на левую
          g.save()
          g.scale(-1, 1)
          g.drawImage(c, 0, 16, 16, 16, -32, 48, 16, 16)
          g.drawImage(c, 40, 16, 16, 16, -48, 48, 16, 16)
          g.restore()
        } else g.drawImage(img, 0, 0, 64, 64)
        pushUndo()
        data.current = g.getImageData(0, 0, 64, 64)
        if (isSlim !== undefined) setSlim(isSlim)
        else {
          // эвристика: у тонкой модели пиксель (54,20) прозрачный
          const a = data.current.data[(20 * 64 + 54) * 4 + 3]
          setSlim(a === 0)
        }
        redraw()
        updatePreview()
        resolve()
      }
      img.onerror = () => reject(new Error('Не удалось открыть картинку'))
      img.src = src
    })

  const importFile = (): void => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/png'
    input.onchange = () => {
      const f = input.files?.[0]
      if (!f) return
      setName(f.name.replace(/\.png$/i, ''))
      const r = new FileReader()
      r.onload = () => loadImage(r.result as string).catch((e) => toast(e.message, 'error'))
      r.readAsDataURL(f)
    }
    input.click()
  }

  const exportFile = (): void => {
    const a = document.createElement('a')
    a.href = toDataUrl()
    a.download = `${name || 'skin'}.png`
    a.click()
  }

  const byNick = async (source: 'mojang' | 'ely'): Promise<void> => {
    if (!nick.trim()) return
    setBusy(true)
    try {
      const r = await api.skinByName(nick.trim(), source)
      await loadImage(r.data, r.slim)
      setName(nick.trim())
    } catch (e) {
      toast((e as Error).message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const fromAccount = async (): Promise<void> => {
    if (!account?.skinUrl) return toast('У аккаунта нет скина', 'error')
    try {
      await loadImage(await api.fetchImage(account.skinUrl))
      setName(account.name)
    } catch (e) {
      toast((e as Error).message, 'error')
    }
  }

  const save = async (): Promise<void> => {
    await api.saveSkin(name, toDataUrl(), slim)
    setSaved(await api.savedSkins())
    toast('Скин сохранён в библиотеку', 'success')
  }

  const apply3 = async (): Promise<void> => {
    if (!account) return toast('Нет аккаунта', 'error')
    if (account.type === 'microsoft') {
      setBusy(true)
      try {
        await api.uploadSkin(account.id, toDataUrl(), slim)
        toast('Скин установлен на аккаунт Microsoft!', 'success')
        useStore.getState().refreshAccounts()
      } catch (e) {
        toast((e as Error).message, 'error')
      } finally {
        setBusy(false)
      }
    } else if (account.type === 'elyby') {
      exportFile()
      toast('Файл скина сохранён. Загрузите его на странице Ely.by → «Сменить скин».')
      api.openUrl('https://ely.by/skins')
    } else if (account.type === 'offline') {
      try {
        await api.setOfflineSkin(account.id, toDataUrl(), slim)
        toast(`Скин установлен на «${account.name}». Он будет виден в игре со следующего запуска.`, 'success')
        useStore.getState().refreshAccounts()
      } catch (e) {
        toast((e as Error).message, 'error')
      }
    } else {
      exportFile()
      toast('Скин экспортирован в PNG — загрузите его на сайте вашего скин-сервера.')
    }
  }

  const tools: { id: Tool; icon: typeof Pencil; label: string }[] = [
    { id: 'pencil', icon: Pencil, label: 'Карандаш (B)' },
    { id: 'eraser', icon: Eraser, label: 'Ластик (E, ПКМ)' },
    { id: 'fill', icon: PaintBucket, label: 'Заливка (G)' },
    { id: 'picker', icon: Pipette, label: 'Пипетка (I)' },
    { id: 'lighten', icon: Sun, label: 'Осветлить' },
    { id: 'darken', icon: Moon, label: 'Затемнить' }
  ]

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>Редактор скинов</h1>
          <p>Рисуйте попиксельно, смотрите результат в 3D и ставьте скин на аккаунт</p>
        </div>
        <div className="actions">
          <button className="btn" onClick={importFile}><Upload size={15} /> Открыть PNG</button>
          <button className="btn" onClick={exportFile}><Download size={15} /> Экспорт</button>
          <button className="btn" onClick={save}><Save size={15} /> В библиотеку</button>
          <button className="btn primary" disabled={busy} onClick={apply3}>{busy ? <Spinner /> : <CloudUpload size={15} />} Установить на аккаунт</button>
        </div>
      </div>

      <div className="skin-layout">
        <div className="card pad col" style={{ gap: 14 }}>
          <div className="row wrap">
            <div className="tools">
              {tools.map((t) => (
                <button key={t.id} title={t.label} className={`tool ${tool === t.id ? 'active' : ''}`} onClick={() => setTool(t.id)}>
                  <t.icon size={18} />
                </button>
              ))}
            </div>
            <div className="tools">
              <button title="Отменить (Ctrl+Z)" className="tool" onClick={doUndo}><Undo2 size={18} /></button>
              <button title="Повторить (Ctrl+Y)" className="tool" onClick={doRedo}><Redo2 size={18} /></button>
              <button title="Сетка" className={`tool ${grid ? 'active' : ''}`} onClick={() => setGrid(!grid)}><Grid3x3 size={18} /></button>
              <button title="Симметрия рук и ног" className={`tool ${mirror ? 'active' : ''}`} onClick={() => setMirror(!mirror)}><FlipHorizontal size={18} /></button>
              <button title="Новый скин" className="tool" onClick={() => { pushUndo(); data.current = generateDefault(); redraw(); updatePreview() }}><RotateCcw size={18} /></button>
            </div>
            <span className="grow" />
            <div className="seg">
              <button className={layer === 'both' ? 'active' : ''} onClick={() => setLayer('both')}><Layers size={14} /> Все</button>
              <button className={layer === 'base' ? 'active' : ''} onClick={() => setLayer('base')}>Основной</button>
              <button className={layer === 'overlay' ? 'active' : ''} onClick={() => setLayer('overlay')}>Верхний слой</button>
            </div>
          </div>
          <div className="skin-canvas-wrap">
            <canvas
              ref={editRef}
              className="skin-canvas"
              width={64 * SCALE}
              height={64 * SCALE}
              style={{ width: '100%', maxWidth: 560, aspectRatio: '1' }}
              onPointerDown={onDown}
              onPointerMove={onMove}
              onPointerUp={onUp}
              onContextMenu={(e) => e.preventDefault()}
            />
          </div>
          <div className="row wrap" style={{ gap: 14 }}>
            <input type="color" className="color-input" style={{ width: 64 }} value={color} onChange={(e) => setColor(e.target.value)} />
            <div className="palette grow">
              {PALETTE.map((c) => (
                <div key={c} className={`swatch ${c === color ? 'active' : ''}`} style={{ background: c }} onClick={() => { setColor(c); if (tool !== 'pencil' && tool !== 'fill') setTool('pencil') }} />
              ))}
            </div>
          </div>
          <div className="small muted">
            <span className="kbd">ЛКМ</span> рисовать · <span className="kbd">ПКМ</span> стереть · <span className="kbd">Ctrl+Z</span> отмена · подсвеченные рамки — области скина, красным — пиксели, скрытые в тонкой модели.
          </div>
        </div>

        <div className="col" style={{ gap: 14 }}>
          <div className="card pad col">
            <canvas ref={viewRef} className="skin-3d" />
            <div className="row">
              <div className="seg">
                <button className={!slim ? 'active' : ''} onClick={() => setSlim(false)}>Steve (4px)</button>
                <button className={slim ? 'active' : ''} onClick={() => setSlim(true)}>Alex (3px)</button>
              </div>
              <span className="grow" />
              <button className="btn sm icon" title="Анимация" onClick={() => setWalk(!walk)}>{walk ? <Pause size={14} /> : <Play size={14} />}</button>
            </div>
            <div className="field">
              <label>Название</label>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>

          <div className="card pad col">
            <h3>Загрузить скин</h3>
            <div className="row">
              <input className="input" placeholder="Ник игрока" value={nick} onChange={(e) => setNick(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && byNick('mojang')} />
            </div>
            <div className="row">
              <button className="btn sm grow" disabled={busy} onClick={() => byNick('mojang')}>Mojang</button>
              <button className="btn sm grow" disabled={busy} onClick={() => byNick('ely')}>Ely.by</button>
              <button className="btn sm grow" onClick={fromAccount}><UserRound size={13} /> Мой</button>
            </div>
          </div>

          <div className="card pad col">
            <h3 className="row">
              Библиотека
              <span className="grow" />
              <button className="btn ghost sm icon" title="Открыть папку" onClick={() => api.openSkinsFolder()}><FolderOpen size={14} /></button>
            </h3>
            {saved.length === 0 && <div className="small muted">Сохранённые скины появятся здесь.</div>}
            <div className="saved-skins">
              {saved.map((s) => (
                <div key={s.file} className="saved-skin" onClick={() => { setName(s.name); loadImage(s.data, s.slim) }}>
                  <SavedThumb src={s.data} />
                  <div className="ellipsis">{s.name}</div>
                  <button
                    className="btn ghost sm icon"
                    style={{ position: 'absolute', top: 2, right: 2, width: 22, height: 22 }}
                    onClick={async (e) => {
                      e.stopPropagation()
                      await api.deleteSkin(s.file)
                      setSaved(await api.savedSkins())
                    }}
                  >
                    <Trash2 size={11} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function SavedThumb({ src }: { src: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const img = new Image()
    img.onload = () => {
      const g = ref.current?.getContext('2d')
      if (!g) return
      g.imageSmoothingEnabled = false
      g.clearRect(0, 0, 16, 16)
      // упрощённый вид спереди: голова, тело, руки, ноги
      g.drawImage(img, 8, 8, 8, 8, 4, 0, 8, 8)
      g.drawImage(img, 40, 8, 8, 8, 4, 0, 8, 8)
      g.drawImage(img, 20, 20, 8, 12, 4, 8, 8, 8)
      g.drawImage(img, 44, 20, 4, 12, 0, 8, 4, 8)
      g.drawImage(img, 36, 52, 4, 12, 12, 8, 4, 8)
    }
    img.src = src
  }, [src])
  return <canvas ref={ref} width={16} height={16} />
}
