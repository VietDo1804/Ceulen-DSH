import type { PluginContext } from '../../core/types.js'
import { errorMessage } from '../../core/tools.js'
import { logLine } from '../../core/log.js'
import { renderFrame, type DnaSnapshot } from './dna.js'
import { createDnaScene } from './dna-scene.js'

/** `/context --play` scene, registered on first use like `/config`. */
export const DNA_SCENE_ID = 'ceulen-context-dna'

interface TuiScenesLike {
  register(descriptor: { id: string; title?: string; component: unknown }, identity?: unknown): () => void
  open(id: string): boolean
}

/** Frames handed to the scene component when it mounts. */
let dnaSnapshots: readonly DnaSnapshot[] = []
let dnaScenes: TuiScenesLike | undefined
let dnaSceneInjected = false

function sceneService(ctx: PluginContext): TuiScenesLike | undefined {
  try {
    const service = ctx.get('tuiScenes', false) as TuiScenesLike | undefined
    if (service === undefined || typeof service.register !== 'function' || typeof service.open !== 'function') return undefined
    return service
  } catch {
    return undefined
  }
}

function registerDnaScene(ctx: PluginContext): void {
  if (dnaScenes !== undefined) return
  const scenes = sceneService(ctx)
  if (scenes === undefined) return
  try {
    const disposer = scenes.register({
      id: DNA_SCENE_ID,
      title: 'Context DNA',
      component: createDnaScene({ snapshots: () => dnaSnapshots }),
    })
    dnaScenes = scenes
    ctx.effect(() => () => {
      disposer()
      dnaScenes = undefined
    }, 'ceulen context dna scene')
    logLine('context', 'registered the /context --play scene')
  } catch (error) {
    logLine('context', `dna scene registration failed: ${errorMessage(error)}`)
  }
}

/**
 * The scene seam, registered from a live child activation (the guard the
 * config panel already documents). Falls back to a direct register for a
 * non-strict embedder.
 */
function ensureDnaScene(ctx: PluginContext): TuiScenesLike | undefined {
  if (dnaScenes !== undefined) return dnaScenes
  if (!dnaSceneInjected) {
    dnaSceneInjected = true
    try {
      ctx.inject(['tuiScenes'], child => {
        registerDnaScene(child)
      })
    } catch (error) {
      dnaSceneInjected = false
      logLine('context', `dna scene injection unavailable: ${errorMessage(error)}`)
    }
  }
  if (dnaScenes === undefined) registerDnaScene(ctx)
  return dnaScenes
}

/** The static frame, shown when no scene is mounted (headless, or a plain shell). */
export function dnaReport(snapshots: readonly DnaSnapshot[], options: { width: number; color: boolean }): string {
  const latest = snapshots[snapshots.length - 1]
  if (latest === undefined) return 'No model request recorded in this session yet.'
  const lines = renderFrame(latest, {
    width: Math.max(20, options.width - 2),
    limit: 8,
    color: options.color,
  })
  if (snapshots.length > 1) {
    lines.push(`${snapshots.length} requests recorded — open the TUI scene with /context --play to replay them`)
  }
  return lines.join('\n')
}

/** Point the mounted scene at this frame list and open it; false when no scene. */
export function openDnaReplay(ctx: PluginContext, snapshots: readonly DnaSnapshot[]): boolean {
  dnaSnapshots = snapshots
  return ensureDnaScene(ctx)?.open(DNA_SCENE_ID) === true
}

