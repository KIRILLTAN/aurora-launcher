// Генерирует иконку Aurora Launcher (build/icon.png и build/icon.ico) без внешних зависимостей.
import { writeFileSync, mkdirSync } from 'fs'
import { deflateSync } from 'zlib'

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
function png(size, pixel) {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  const SS = 3
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const [pr, pg, pb, pa] = pixel((x + (sx + 0.5) / SS) / size, (y + (sy + 0.5) / SS) / size)
          r += pr * pa; g += pg * pa; b += pb * pa; a += pa
        }
      const o = y * (size * 4 + 1) + 1 + x * 4
      const n = SS * SS
      raw[o] = a ? r / a : 0
      raw[o + 1] = a ? g / a : 0
      raw[o + 2] = a ? b / a : 0
      raw[o + 3] = (a / n) * 255
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

const mix = (a, b, t) => a + (b - a) * t
const clamp = (v) => Math.max(0, Math.min(1, v))
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy))
  return Math.hypot(px - ax - dx * t, py - ay - dy * t)
}

function pixel(u, v) {
  // скруглённый квадрат
  const m = 0.04, rad = 0.22
  const qx = Math.abs(u - 0.5) - (0.5 - m - rad)
  const qy = Math.abs(v - 0.5) - (0.5 - m - rad)
  const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - rad
  if (d > 0) return [0, 0, 0, 0]
  // ночное небо
  let r = mix(10, 30, v), g = mix(12, 16, v), b = mix(38, 70, v)
  // ленты северного сияния
  const bands = [
    { c: [64, 255, 170], y: 0.36, a: 0.09, f: 2.2, p: 0.0, w: 0.07 },
    { c: [60, 200, 255], y: 0.46, a: 0.07, f: 2.8, p: 1.3, w: 0.06 },
    { c: [190, 110, 255], y: 0.56, a: 0.08, f: 1.9, p: 2.6, w: 0.08 }
  ]
  for (const bd of bands) {
    const cy = bd.y + Math.sin(u * Math.PI * bd.f + bd.p) * bd.a
    const t = Math.exp(-(((v - cy) / bd.w) ** 2)) * 0.85
    r = mix(r, bd.c[0], t); g = mix(g, bd.c[1], t); b = mix(b, bd.c[2], t)
  }
  // буква A
  const sw = 0.055
  const dA = Math.min(
    segDist(u, v, 0.5, 0.2, 0.28, 0.8),
    segDist(u, v, 0.5, 0.2, 0.72, 0.8),
    segDist(u, v, 0.37, 0.58, 0.63, 0.58)
  )
  const glow = Math.exp(-((dA / 0.09) ** 2)) * 0.35
  r = mix(r, 255, glow); g = mix(g, 255, glow); b = mix(b, 255, glow)
  if (dA < sw) { r = 255; g = 255; b = 255 }
  return [r, g, b, 1]
}

mkdirSync('build', { recursive: true })
const big = png(512, pixel)
writeFileSync('build/icon.png', big)
const small = png(256, pixel)
const header = Buffer.alloc(6 + 16)
header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4)
header[6] = 0; header[7] = 0; header[8] = 0; header[9] = 0
header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12)
header.writeUInt32LE(small.length, 14); header.writeUInt32LE(22, 18)
writeFileSync('build/icon.ico', Buffer.concat([header, small]))
writeFileSync('src/renderer/src/assets/logo.png', small)
console.log('Иконки созданы: build/icon.png, build/icon.ico, src/renderer/src/assets/logo.png')
