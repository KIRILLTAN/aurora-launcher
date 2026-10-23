import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Instance, Settings } from '@shared/types'
import { exists } from '../util/store'

/**
 * Оптимизированные аргументы JVM для клиента Minecraft.
 * G1: флаги в духе Aikar — короткие паузы сборщика, меньше микрофризов.
 * ZGC (Java 21+): паузы < 1 мс, хорош при 8+ ГБ памяти.
 */
export function optimizedJvmArgs(preset: Settings['jvmPreset'], javaMajor: number, memMb: number): string[] {
  if (preset === 'custom') return []
  const common = ['-XX:+UnlockExperimentalVMOptions', '-XX:+DisableExplicitGC', '-XX:+PerfDisableSharedMem', '-XX:+UseStringDeduplication']
  if (preset === 'zgc' && javaMajor >= 21) {
    return ['-XX:+UseZGC', ...(javaMajor <= 22 ? ['-XX:+ZGenerational'] : []), ...common]
  }
  const big = memMb >= 12288
  return [
    '-XX:+UseG1GC',
    '-XX:+ParallelRefProcEnabled',
    '-XX:MaxGCPauseMillis=37',
    ...common,
    '-XX:+AlwaysActAsServerClassMachine',
    `-XX:G1NewSizePercent=${big ? 40 : 30}`,
    `-XX:G1MaxNewSizePercent=${big ? 50 : 40}`,
    `-XX:G1HeapRegionSize=${big ? '16M' : '8M'}`,
    `-XX:G1ReservePercent=${big ? 15 : 20}`,
    '-XX:G1HeapWastePercent=5',
    '-XX:G1MixedGCCountTarget=4',
    `-XX:InitiatingHeapOccupancyPercent=${big ? 20 : 15}`,
    '-XX:G1MixedGCLiveThresholdPercent=90',
    '-XX:G1RSetUpdatingPauseTimePercent=5',
    '-XX:SurvivorRatio=32',
    '-XX:MaxTenuringThreshold=1',
    ...(javaMajor >= 17 ? ['-XX:+UseNUMA'] : [])
  ]
}

/** Автоподбор памяти: ваниле хватает 2–3 ГБ, большим сборкам — до 10–12 ГБ, но не больше 60% ОЗУ. */
export function autoMemory(inst: Instance, gameDir: string): number {
  let mods = 0
  const dir = path.join(gameDir, 'mods')
  if (exists(dir)) mods = fs.readdirSync(dir).filter((f) => f.endsWith('.jar')).length
  const shaders = exists(path.join(gameDir, 'shaderpacks')) && fs.readdirSync(path.join(gameDir, 'shaderpacks')).length > 0
  let want = inst.loader === 'vanilla' ? 2560 : 3072 + mods * 28
  if (shaders) want += 1024
  const total = Math.floor(os.totalmem() / 1048576)
  const cap = Math.min(12288, Math.floor(total * 0.6))
  const mem = Math.max(2048, Math.min(want, cap))
  return Math.round(mem / 512) * 512
}
