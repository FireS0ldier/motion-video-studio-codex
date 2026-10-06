import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CACHE } from '../../cli/lib/paths.ts'
import { isWritableDir, pythonCacheEnv } from '../../cli/lib/python.ts'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
// normalized, so the checks also pass on Windows checkouts with CRLF line endings
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

function filesIn(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => relative(join(ROOT, dir), join(e.parentPath, e.name)))
    .sort()
}
const skillNames = (base: string) =>
  readdirSync(join(ROOT, base), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

describe('agent guide', () => {
  it('AGENTS.md is the full guide and leaves room in Codex’s 32 KiB instruction budget', () => {
    // Codex reads at most project_doc_max_bytes = 32 KiB from the AGENTS.md files between the
    // project root and the working directory (and truncates the rest); keep room for nested ones.
    expect(statSync(join(ROOT, 'AGENTS.md')).size).toBeLessThan(24 * 1024)
    const guide = read('AGENTS.md')
    for (const h of ['## 2. Files: what you may change', '## 3. Create a new video', '## 5. Writing scenes', '## 7. Quality bar', '## 8. Diagnosing problems']) {
      expect(guide).toContain(h)
    }
  })

  it('is the Codex edition: no Claude Code files, and the guide does not point to them', () => {
    expect(existsSync(join(ROOT, 'CLAUDE.md'))).toBe(false)
    expect(existsSync(join(ROOT, '.claude'))).toBe(false)
    // docs/codex.md names the original edition on purpose; CHANGELOG.md keeps history
    const guides = [
      'AGENTS.md',
      'README.md',
      'CONTRIBUTING.md',
      ...readdirSync(join(ROOT, 'docs'))
        .filter((f) => f.endsWith('.md') && f !== 'codex.md')
        .map((f) => `docs/${f}`),
      ...skillNames('.agents/skills').map((n) => `.agents/skills/${n}/SKILL.md`),
    ]
    for (const doc of guides) expect(read(doc), doc).not.toMatch(/CLAUDE\.md|\.claude\/|Claude Code/)
  })
})

describe('Codex project settings', () => {
  it('.codex/config.toml turns on network for the sandbox and sets the model', () => {
    const toml = read('.codex/config.toml')
    expect(toml).toMatch(/^model = "gpt-[\w.-]+"$/m)
    expect(toml).toMatch(/^model_reasoning_effort = "(low|medium|high|xhigh|max|ultra)"$/m)
    expect(toml).toMatch(/^\[sandbox_workspace_write\]\nnetwork_access = true$/m)
  })
})

describe('project skills', () => {
  it('Codex finds the skills in .agents/skills', () => {
    expect(skillNames('.agents/skills')).toEqual(['add-scene', 'create-video', 'review-video'])
  })

  it('every skill follows the Agent Skills spec (agentskills.io)', () => {
    for (const name of skillNames('.agents/skills')) {
      expect(filesIn(`.agents/skills/${name}`)).toContain('SKILL.md')
      const text = read(`.agents/skills/${name}/SKILL.md`)
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(text)
      expect(fm, `${name}: frontmatter`).not.toBeNull()
      const keys = [...fm![1].matchAll(/^([a-z-]+):/gm)].map((m) => m[1])
      for (const k of keys) expect(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']).toContain(k)
      const field = (k: string) => new RegExp(`^${k}:\\s*(.+)$`, 'm').exec(fm![1])?.[1].trim()
      expect(field('name')).toBe(name)
      expect(name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(name.length).toBeLessThanOrEqual(64)
      const description = field('description') ?? ''
      expect(description.length).toBeGreaterThan(20)
      expect(description.length).toBeLessThanOrEqual(1024)
    }
  })
})

/** GitHub's heading anchor: lower case, punctuation dropped, spaces → hyphens. */
function slug(heading: string): string {
  return heading
    .replace(/`/g, '')
    .replace(/\*\*|__/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-')
}

function anchorsOf(file: string): Set<string> {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n').replace(/^```[\s\S]*?^```/gm, '')
  return new Set([...text.matchAll(/^#{1,6} +(.+?) *$/gm)].map((m) => slug(m[1])))
}

describe('documentation links', () => {
  const docs = [
    'README.md',
    'AGENTS.md',
    ...readdirSync(join(ROOT, 'docs'))
      .filter((f) => f.endsWith('.md'))
      .map((f) => `docs/${f}`),
    ...skillNames('.agents/skills').map((n) => `.agents/skills/${n}/SKILL.md`),
  ]

  it.each(docs)('%s: relative links point to existing files and headings', (doc) => {
    const text = read(doc)
      .replace(/^```[\s\S]*?^```/gm, '')
      .replace(/`[^`\n]*`/g, '')
    const broken: string[] = []
    for (const m of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      const target = m[1]
      if (/^[a-z]+:/i.test(target)) continue
      const [path, anchor] = target.split('#') as [string, string | undefined]
      const file = path ? resolve(dirname(join(ROOT, doc)), decodeURIComponent(path)) : join(ROOT, doc)
      if (!existsSync(file)) {
        broken.push(`${target} (missing file)`)
        continue
      }
      if (anchor && file.endsWith('.md') && !anchorsOf(file).has(anchor.toLowerCase())) broken.push(`${target} (missing heading)`)
    }
    expect(broken).toEqual([])
  })
})

describe('Python cache folders in sandboxes', () => {
  it('keeps the defaults when the user cache folder is writable', () => {
    const seen: string[] = []
    expect(pythonCacheEnv({ HOME: '/home/u' }, (d) => (seen.push(d), true), 'linux')).toEqual({})
    expect(seen).toEqual([join('/home/u', '.cache')])
  })

  it('moves uv, Hugging Face and PyTorch caches into .cache/python when it is not', () => {
    const seen: string[] = []
    const env = pythonCacheEnv({ XDG_CACHE_HOME: '/ro/cache' }, (d) => (seen.push(d), false), 'linux')
    expect(seen).toEqual(['/ro/cache'])
    expect(env).toEqual({
      UV_CACHE_DIR: join(CACHE, 'python', 'uv'),
      UV_PYTHON_INSTALL_DIR: join(CACHE, 'python', 'uv-python'),
      HF_HOME: join(CACHE, 'python', 'huggingface'),
      TORCH_HOME: join(CACHE, 'python', 'torch'),
    })
  })

  it('never overrides a folder the user chose', () => {
    const env = pythonCacheEnv({ XDG_CACHE_HOME: '/ro', UV_CACHE_DIR: '/mine/uv', HF_HOME: '/mine/hf' }, () => false, 'linux')
    expect(Object.keys(env).sort()).toEqual(['TORCH_HOME', 'UV_PYTHON_INSTALL_DIR'])
  })

  it('uses LOCALAPPDATA on Windows', () => {
    const seen: string[] = []
    pythonCacheEnv({ LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, (d) => (seen.push(d), true), 'win32')
    expect(seen).toEqual(['C:\\Users\\u\\AppData\\Local'])
    // no LOCALAPPDATA: the default is unknown, so the caches stay in the repository
    expect(Object.keys(pythonCacheEnv({}, () => true, 'win32'))).toContain('UV_CACHE_DIR')
  })

  it('detects folders it cannot write to', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'mvs-writable-'))
    expect(isWritableDir(join(tmp, 'new', 'cache'))).toBe(true)
    const file = join(tmp, 'a-file')
    writeFileSync(file, '')
    expect(isWritableDir(join(file, 'cache'))).toBe(false)
    // returns instead of looping where mkdir -p would (procfs)
    if (process.platform === 'linux') expect(isWritableDir('/proc/mvs-test/cache')).toBe(false)
    rmSync(tmp, { recursive: true, force: true })
  })
})
