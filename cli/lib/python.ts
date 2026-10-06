/**
 * Runs the optional Python tools in tools/python through `uv` (ephemeral,
 * cached environments; nothing is installed globally). Falls back to a plain
 * `python3` that already has the packages.
 */

import { spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { which, runSync } from './exec.ts'
import { CliError, log } from './log.ts'
import { CACHE, TOOLS } from './paths.ts'

export interface PythonRunner {
  kind: 'uv' | 'python-m-uv' | 'python'
  describe: string
}

/** Python modules a pip requirement provides, e.g. "piper-tts[alignment]==1.8.0" → piper, onnx. */
export function importNames(requirement: string): string[] {
  const name = requirement.replace(/\[.*?\]/, '').replace(/[<>=!~;].*$/, '').trim().toLowerCase()
  const known: Record<string, string> = { 'piper-tts': 'piper', 'kokoro-onnx': 'kokoro_onnx', 'onnxruntime-gpu': 'onnxruntime' }
  const mods = [known[name] ?? name.replace(/-/g, '_')]
  if (/\[[^\]]*alignment/.test(requirement) && name === 'piper-tts') mods.push('onnx')
  return mods
}

export function findPythonRunner(): PythonRunner | null {
  if (which('uv')) return { kind: 'uv', describe: 'uv' }
  for (const py of ['python3', 'python']) {
    if (!which(py)) continue
    if (runSync(py, ['-m', 'uv', '--version']).code === 0) return { kind: 'python-m-uv', describe: `${py} -m uv` }
  }
  return null
}

/** True when files can be created in `dir`, or in the nearest existing parent that would hold it. */
export function isWritableDir(dir: string): boolean {
  // no mkdir: recursive mkdirSync never returns on some file systems (e.g. below /proc)
  let d = resolve(dir)
  while (!existsSync(d)) {
    const up = dirname(d)
    if (up === d) return false
    d = up
  }
  const probe = join(d, `.mvs-write-test-${process.pid}`)
  try {
    writeFileSync(probe, '')
    rmSync(probe, { force: true })
    return true
  } catch {
    return false
  }
}

/**
 * Cache folders for the Python tools. uv, Hugging Face and PyTorch keep their caches
 * in the user's cache folder (~/.cache). Agent sandboxes (e.g. Codex) often allow
 * writes only inside the repository: then the caches move to .cache/python/.
 * Variables the user set are kept. Returns only the variables to add.
 */
export function pythonCacheEnv(
  env: NodeJS.ProcessEnv = process.env,
  writable: (dir: string) => boolean = isWritableDir,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const home = env.HOME || env.USERPROFILE || safeHomedir()
  const base = platform === 'win32' ? env.LOCALAPPDATA : env.XDG_CACHE_HOME || (home && join(home, '.cache'))
  // unknown cache folder (no home): the tools could not use their defaults either
  if (base && writable(base)) return {}
  const local = join(CACHE, 'python')
  const dirs: Record<string, string> = {
    UV_CACHE_DIR: join(local, 'uv'),
    UV_PYTHON_INSTALL_DIR: join(local, 'uv-python'),
    HF_HOME: join(local, 'huggingface'),
    TORCH_HOME: join(local, 'torch'),
  }
  return Object.fromEntries(Object.entries(dirs).filter(([k]) => !env[k]))
}

function safeHomedir(): string {
  try {
    return homedir()
  } catch {
    return '' // no HOME and no passwd entry
  }
}

let cacheEnv: Record<string, string> | undefined
function toolCacheEnv(): Record<string, string> {
  if (!cacheEnv) {
    cacheEnv = pythonCacheEnv()
    if (Object.keys(cacheEnv).length) log.dim('  user cache folder is not writable (sandbox?): Python caches go to .cache/python/')
  }
  return cacheEnv
}

function pythonExe(): string | null {
  return which('python3') ?? which('python')
}

/**
 * Run tools/python/<script> with the given packages available.
 * stderr is streamed (progress), stdout returned.
 */
export async function runPythonTool(script: string, args: string[], packages: string[], opts: { python?: string } = {}): Promise<string> {
  const runner = findPythonRunner()
  const file = join(TOOLS, 'python', script)
  let cmd: string
  let argv: string[]
  const withs = packages.flatMap((p) => ['--with', p])
  const py = opts.python ? ['--python', opts.python] : []
  if (runner?.kind === 'uv') {
    cmd = 'uv'
    argv = ['run', '--no-project', '--quiet', ...py, ...withs, 'python', file, ...args]
  } else if (runner?.kind === 'python-m-uv') {
    cmd = pythonExe()!
    argv = ['-m', 'uv', 'run', '--no-project', '--quiet', ...py, ...withs, 'python', file, ...args]
  } else {
    const exe = pythonExe()
    if (!exe) throw new CliError('Python is not installed.', 'Install uv (https://docs.astral.sh/uv/) — it manages Python and the packages for you.')
    const mods = packages.flatMap(importNames)
    const check = runSync(exe, ['-c', mods.map((m) => `import ${m}`).join(';')])
    if (check.code !== 0) throw new CliError(`Python packages missing: ${packages.join(', ')}`, 'Install uv (https://docs.astral.sh/uv/) and re-run; it provides them automatically.')
    cmd = exe
    argv = [file, ...args]
  }
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...toolCacheEnv(), PYTHONUNBUFFERED: '1', UV_NO_PROGRESS: '1' }
    const child = spawn(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], env })
    let out = ''
    let err = ''
    let lineStart = true
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString()
      err += s
      // prefix tool output so it is visually nested under the CLI step
      let pretty = ''
      for (const ch of s) {
        if (lineStart && ch !== '\n') pretty += '  │ '
        pretty += ch
        lineStart = ch === '\n'
      }
      process.stderr.write(pretty)
    })
    child.on('close', () => lineStart || process.stderr.write('\n'))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve(out)
      else reject(new CliError(`${script} failed (exit ${code}).`, err.trim().split('\n').slice(-4).join('\n')))
    })
  })
}
