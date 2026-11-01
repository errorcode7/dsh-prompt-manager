// dsh-prompt-manager — view, hook, replace, and switch DeepSeek Harness system prompts.
//
// Host half: a Cordis plugin bundle.
//  - `PromptManager` service (ctx.promptManager): preset store under
//    $DSH_HOME/prompts (config `root` overrides), hot-reloaded on file change.
//  - `system-prompt/assemble` waterfall hook: applies the active preset's
//    overrides (replace / insert / remove) to the assembled sections. The
//    waterfall return value is authoritative, so the hook works for every
//    scope; a scope with an effective `complete: true` section is restored by
//    the registry after the waterfall (documented limitation).
//  - Agent tools: switch_prompt / list_prompts / get_prompt / save_prompt.
//  - A dedicated Connection RPC channel (`/prompt-manager-rpc`) for the client
//    half and the standalone pipeline page.
import { isModelInvocable } from '@deepseek-ai/dsh-skill'
import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { dump as dumpYaml, load as parseYaml } from 'js-yaml'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspect } from 'node:util'

/** Cordis plugin name. */
export const name = 'prompt-manager'
/** Required services. */
export const inject = ['systemPrompt', 'tools']
/** Pure preset helpers, exported for tests and reuse. */
export { applyPreset, applyPresetKeyed, normalizePreset }
/** Runtime schema for the prompt-manager row. */
export const Config = z.object({
  /** Override the preset store directory (default: $DSH_HOME/prompts). */
  root: z.string()
})

/** Preset file names must be lowercase `[a-z][a-z0-9_-]*` (also the file basename). */
const PRESET_NAME_RE = /^[a-z][a-z0-9_-]*$/
/** Section names follow the registry's `namespace:name` convention. */
const SECTION_NAME_RE = /^[a-z][a-z0-9_.:-]*$/
/** Active-pointer file inside the preset store. */
const ACTIVE_FILENAME = 'active.yml'
/** Valid preset rule actions. */
const ACTIONS = ['replace', 'insert', 'remove']
/** Sentinel order for a "top" rule: below every base section (harness:identity = -1000),
 *  so `top: true` / 置顶 makes the section render as the very first prompt section. */
const TOP_ORDER = -2000
/** Dedicated RPC channel (shared by the settings tab and the pipeline page). */
const RPC_CHANNEL = '/prompt-manager-rpc'
/** Endpoint names are single URL segments (method names). */
const RPC_ENDPOINT_RE = /^[A-Za-z0-9_$.-]+$/
/** Request body cap for the JSON RPC channel. */
const MAX_RPC_BODY_BYTES = 8 * 1024 * 1024
/** 幕布轮次时间轴：保留最近 N 轮真实组装快照（每次真实模型步骤产生一轮）。 */
const REAL_SNAPSHOT_LIMIT = 20
/** 对话历史侧栏：每个 session 保留最近 M 轮。 */
const SESSION_ROUND_LIMIT = 20
/** 对话历史侧栏：最多跟踪的 session 数（超限丢最久未活动的）。 */
const SESSION_LIMIT = 50

/** Resolve the Harness home (`$DSH_HOME` or `~/.dsh`), mirroring dsh-home-paths. */
function resolveDshHome() {
  const fromEnv = process.env.DSH_HOME
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv.trim() : join(homedir(), '.dsh')
}

/**
 * Static owner index for known prompt sections (name or prefix → source hint).
 * Not authoritative: DSH does not track section registrants, so this is a
 * curated read-only map for display; unknown names fall back to a generic hint.
 */
const SECTION_OWNERS = [
  { match: (name) => name === 'harness:identity', owner: '@deepseek-ai/dsh-system-prompt 内置（order -1000）' },
  { match: (name) => name === 'harness:source', owner: '@deepseek-ai/dsh-harness-dev-context（实现 checkout 说明，order 10000）' },
  { match: (name) => name === 'app:web-surface', owner: '@deepseek-ai/dsh-harness-dev-context（Web 表面说明，order 10100）' },
  { match: (name) => name === 'deployment:persona-prefix', owner: 'dsh-system-prompt 配置 config.personaPrefix（order 0）；可按 agent 由 dsh-subagent 覆盖' },
  { match: (name) => name === 'deployment:persona-suffix', owner: 'dsh-system-prompt 配置 config.personaSuffix（order 10200）' },
  { match: (name) => name.startsWith('plan:'), owner: '@deepseek-ai/dsh-plan-mode（计划模式策略段）' },
  { match: (name) => name.startsWith('tool:'), owner: '工具插件（@deepseek-ai/dsh-tool-*，经 dsh-tools 注册）' },
  { match: (name) => name.startsWith('tools:') || name.startsWith('code-'), owner: '@deepseek-ai/dsh-tools（工具/代码模式引导）' },
  { match: (name) => name.startsWith('ui:'), owner: 'Web 前端插件（dsh-client-ui-*）' },
  { match: () => true, owner: '未知来源（第三方插件或部署注入）' }
]

/** Resolve the owner hint for a section name. */
function resolveOwner(name) {
  for (const entry of SECTION_OWNERS) if (entry.match(name)) return entry.owner
  return '未知来源'
}

/** Known numeric orders for well-known sections (registry drops order from assembled sections). */
const ORDER_HINTS = new Map([
  ['harness:identity', -1000],
  ['deployment:persona-prefix', 0],
  ['plan:policy', 500],
  ['harness:source', 10000],
  ['app:web-surface', 10100],
  ['deployment:persona-suffix', 10200]
])

/** Order hint for the pipeline view: known numeric order, else relative position. */
function orderHintOf(name, index) {
  return ORDER_HINTS.get(name) ?? index + 1
}

/** Interpolate `{{variable}}` references with the given values; unknown ones stay literal. */
function interpolateText(text, variables) {
  return text.replace(/\{\{([a-z][a-z0-9_]*)\}\}/g, (match, name) => {
    const value = variables[name]
    return value === undefined ? match : value
  })
}

/**
 * Validate and normalize one parsed preset document.
 * @param raw - the parsed YAML value.
 * @param name - the preset name (file basename).
 * @returns the normalized preset.
 */
function normalizePreset(raw, name) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`preset "${name}" must be a YAML mapping`)
  const label = raw.label === undefined ? name : String(raw.label)
  const description = raw.description === undefined ? '' : String(raw.description)
  const overrides = []
  const list = Array.isArray(raw.overrides) ? raw.overrides : []
  for (const rule of list) {
    if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) throw new Error(`preset "${name}": each override must be a mapping`)
    const action = rule.action
    if (!ACTIONS.includes(action)) throw new Error(`preset "${name}": unknown action ${JSON.stringify(action)} (expected ${ACTIONS.join('|')})`)
    const section = rule.section === undefined ? '' : String(rule.section)
    if (!SECTION_NAME_RE.test(section)) throw new Error(`preset "${name}": invalid section name ${JSON.stringify(section)}`)
    if (action !== 'remove' && typeof rule.text !== 'string') throw new Error(`preset "${name}": ${action} rule for "${section}" requires a string text`)
    // order: explicit number wins; `top: true` (置顶/压倒一切) maps to TOP_ORDER so the
    // rule sorts before every base section. `after` remains the anchor for non-ordered inserts.
    const order = typeof rule.order === 'number' && Number.isFinite(rule.order) ? rule.order : (rule.top === true ? TOP_ORDER : undefined)
    const after = rule.after === undefined ? undefined : String(rule.after)
    overrides.push({ action, section, text: action === 'remove' ? undefined : rule.text, order, after })
  }
  return { name, label, description, overrides }
}

/**
 * Apply preset overrides to one assembled sections list (pure).
 *
 * - replace: rewrite the matching section's text (and optional order); when
 *   the section does not exist, degrade to insert.
 * - insert: append a new section; a duplicate name is skipped.
 * - remove: drop the matching section.
 *
 * Inserted sections are appended after the named `after` section when given,
 * otherwise at the end (the registry drops numeric order from assembled
 * sections, so end placement is the v1 default).
 *
 * Rendering priority (顺序 = 优先级):
 * - When NO rule carries an explicit `order`, placement is purely positional:
 *   `after` anchor (or append at the end). This is the historical behavior.
 * - When ANY rule carries an explicit `order` (or `top` → TOP_ORDER), the whole
 *   result is re-sorted by stable ascending order: sections with an explicit
 *   order jump to that numeric position, all other sections keep their current
 *   array index as the sort key (preserving the registry's base order and the
 *   anchor-based placement of non-ordered inserts). An `order` below -1000 puts
 *   the section ahead of harness:identity (压倒一切); `top: true` uses TOP_ORDER.
 * @param sections - assembled sections (never mutated).
 * @param overrides - normalized preset rules.
 * @returns a new sections array with the overrides applied.
 */
function applyPreset(sections, overrides) {
  return applyPresetKeyed(sections, overrides).map((entry) => entry.section)
}

/**
 * applyPreset + per-section sort keys: returns [{ section, key }] where `key`
 * is the exact numeric sort key the engine used (explicit order, else the
 * section's index in the post-insertion array). The preview surface (and the
 * drag-to-reorder UI) consumes these keys to compute exact midpoint orders.
 * @param sections - assembled sections (never mutated).
 * @param overrides - normalized preset rules.
 * @returns [{ section, key }] in final render order.
 */
function applyPresetKeyed(sections, overrides) {
  const work = [...sections]
  const present = new Set(work.map((section) => section.name))
  const orderRequested = overrides.some((rule) => rule.order !== undefined)
  for (const rule of overrides) {
    if (rule.action === 'replace') {
      const index = work.findIndex((section) => section.name === rule.section)
      if (index >= 0) {
        work[index] = { ...work[index], text: rule.text, ...(rule.order !== undefined ? { order: rule.order } : {}) }
      } else if (!present.has(rule.section)) {
        const entry = { name: rule.section, text: rule.text, ...(rule.order !== undefined ? { order: rule.order } : {}) }
        insertAfter(work, entry, rule.after, present)
      }
    } else if (rule.action === 'insert') {
      if (!present.has(rule.section)) {
        const entry = { name: rule.section, text: rule.text, ...(rule.order !== undefined ? { order: rule.order } : {}) }
        insertAfter(work, entry, rule.after, present)
      }
    } else if (rule.action === 'remove') {
      const index = work.findIndex((section) => section.name === rule.section)
      if (index >= 0) work.splice(index, 1)
    }
  }
  if (orderRequested) {
    // Stable ascending sort: explicit order wins, others keep current index.
    const keyed = work.map((section, index) => ({ section, key: section.order !== undefined ? section.order : index }))
    keyed.sort((a, b) => a.key - b.key)
    return keyed
  }
  return work.map((section, index) => ({ section, key: index }))
}

/** Insert `entry` after the named section (or append at the end), tracking presence. */
function insertAfter(work, entry, after, present) {
  const index = after === undefined ? -1 : work.findIndex((section) => section.name === after)
  if (index >= 0) work.splice(index + 1, 0, entry)
  else work.push(entry)
  present.add(entry.name)
}

/** 工作区指令文件候选（与 dsh-agent-instructions 同款：base + local 覆盖）。 */
const INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md']
const LOCAL_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md']

/**
 * 从 cwd 读取工作区指令文件（AGENTS.md / CLAUDE.md 及其 .local 覆盖），
 * 拼接为画布展示文本。返回 { found, files, text }；找不到文件时 text 为空。
 * 说明：dsh-agent-instructions 还会沿祖先目录（project root）发现文件，
 * 这里仅覆盖 session cwd，消息路径捕获负责呈现模型实际看到的完整组合。
 */
function readWorkspaceInstructions(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return { found: false, files: [], text: '' }
  const files = []
  const chunks = []
  for (const candidates of [INSTRUCTION_FILE_CANDIDATES, LOCAL_INSTRUCTION_FILE_CANDIDATES]) {
    for (const candidate of candidates) {
      const path = join(cwd, candidate)
      if (!existsSync(path)) continue
      try {
        const content = readFileSync(path, 'utf8')
        files.push(candidate)
        chunks.push(`### ${candidate}\n\n${content.trim()}`)
      } catch { /* 单个文件读取失败不影响其余 */ }
    }
  }
  if (files.length === 0) return { found: false, files: [], text: '' }
  return { found: true, files, text: chunks.join('\n\n') }
}

/**
 * The prompt manager service: preset store, hot reload, catalog snapshot,
 * and the RPC/tool read-write face.
 */
class PromptManager extends Service {
  /** Preset store directory. */
  root
  /** Normalized presets by name. */
  presets = new Map()
  /** Active preset name, or null when none. */
  active = null
  /** Latest global catalog snapshot (sections/contexts/tools/variables/rendered). */
  catalog = { sections: [], contexts: [], tools: [], variables: {}, rendered: '', ts: 0 }
  /** The pristine assembly observed by the waterfall (pre-preset), by scope of the last assembly. */
  lastPristine = null
  /** Pristine sections of the LAST `__catalogRefresh` assemble (global scope, race-free). */
  lastCatalogPristine = null
  /** Monotonic counter guarding refreshCatalog against out-of-order commits. */
  refreshSeq = 0
  /** The assembly returned by the waterfall (post-preset). */
  lastApplied = null
  /** The last REAL model-step assembly (agent scope; variables carry values), for the pipeline view. */
  lastReal = null
  /** 最近一次真实模型步骤的用户输入文本（从 agent/pre-step 捕获 claimed 消息）。 */
  lastUserInput = ''
  /** 最近一次 AGENTS.md 工作区指令文本（从 pre-step 注入消息捕获）。 */
  lastWorkspaceInstructions = ''
  /** 最近一次技能目录文本（从 pre-step 注入消息捕获）。 */
  lastSkillsCatalog = ''
  /** Recent real-assembly snapshots (ring buffer) for the pipeline round/time-line view. */
  realSnapshots = []
  /** Per-session real-assembly snapshots for the history side panel. */
  snapshotsBySession = new Map()
  /** 翻译缓存：hash(text) -> { target: { text, ts } }（持久化到 $DSH_HOME/prompts/translations.json）。 */
  translationCache = null
  /** 最近一次真实模型请求的配置（provider/model/sessionId），翻译复用同一路由。 */
  lastRequestConfig = null
  /** Built-in preset directory (shipped with the package). */
  builtinRoot

  constructor(ctx, config) {
    super(ctx, 'promptManager')
    this.root = config.root ?? join(resolveDshHome(), 'prompts')
    this.builtinRoot = join(dirname(fileURLToPath(import.meta.url)), 'presets')
    mkdirSync(this.root, { recursive: true })
    this.reload()
    ctx.effect(() => {
      const watcher = watch(this.root, { persistent: false }, () => {
        try {
          this.reload()
        } catch (error) {
          this.ctx.emit('prompt-manager/error', { source: 'watch', message: String(error?.message ?? error) })
        }
      })
      return () => {
        try { watcher.close() } catch { /* already closed */ }
      }
    })
  }

  /** Read one preset file with its kind and path; returns null when unreadable/invalid. */
  readPresetFile(file, kind, dir) {
    const name = basename(file, '.yml')
    if (!PRESET_NAME_RE.test(name)) return null
    try {
      const preset = normalizePreset(parseYaml(readFileSync(join(dir, file), 'utf8')), name)
      return { ...preset, kind, path: join(dir, file) }
    } catch (error) {
      this.ctx.emit('prompt-manager/error', { source: 'preset', file: join(dir, file), message: String(error?.message ?? error) })
      return null
    }
  }

  /** Reload builtin + user presets and the active pointer (user shadows builtin; keeps last-good state on failure). */
  reload() {
    const next = new Map()
    // builtin first, user shadows same-name presets
    if (existsSync(this.builtinRoot)) {
      for (const file of readdirSync(this.builtinRoot)) {
        if (!file.endsWith('.yml')) continue
        const preset = this.readPresetFile(file, 'builtin', this.builtinRoot)
        if (preset !== null) next.set(preset.name, preset)
      }
    }
    for (const file of readdirSync(this.root)) {
      if (!file.endsWith('.yml') || file === ACTIVE_FILENAME) continue
      const preset = this.readPresetFile(file, 'user', this.root)
      if (preset !== null) next.set(preset.name, preset)
    }
    this.presets = next
    try {
      const activePath = join(this.root, ACTIVE_FILENAME)
      const raw = existsSync(activePath) ? parseYaml(readFileSync(activePath, 'utf8')) : null
      const requested = raw && typeof raw === 'object' ? raw.active : null
      this.active = requested !== null && this.presets.has(requested) ? requested : null
    } catch {
      this.active = null
    }
    this.ctx.emit('prompt-manager/presets-changed')
  }

  /** The active preset's normalized rules, or null when inactive. */
  get activeRules() {
    return this.active === null ? null : this.presets.get(this.active)?.overrides ?? null
  }

  /** Rebuild the global catalog snapshot (best-effort; failures emit an error).
   *  Concurrent refreshes (system-prompt/change + presets-changed + explicit
   *  RPC) can complete out of order; a version guard keeps the newest STARTED
   *  refresh from being clobbered by an older one that finishes later. */
  async refreshCatalog() {
    const runId = ++this.refreshSeq
    try {
      // The `__catalogRefresh` context marker makes the waterfall hook stash the
      // pristine (pre-preset) assembly of THIS exact call into
      // `lastCatalogPristine`, instead of racing with agent-scoped assembles
      // that overwrite the shared `lastPristine` slot.
      const assembly = await this.ctx.systemPrompt.assemble({ __catalogRefresh: true })
      if (runId !== this.refreshSeq) return // a newer refresh started; discard this stale result
      const pristine = this.lastCatalogPristine !== null && this.lastCatalogPristine !== undefined
        ? this.lastCatalogPristine
        : assembly.sections
      let rendered
      try {
        const { renderPrompt } = await import('@deepseek-ai/dsh-system-prompt')
        rendered = renderPrompt(assembly)
      } catch (error) {
        rendered = `(render unavailable: ${String(error?.message ?? error)})`
      }
      this.catalog = {
        sections: assembly.sections,
        pristineSections: pristine,
        contexts: assembly.contexts,
        tools: assembly.tools.map((tool) => tool.name),
        variables: assembly.variables,
        rendered,
        ts: Date.now()
      }
    } catch (error) {
      this.ctx.emit('prompt-manager/error', { source: 'catalog', message: String(error?.message ?? error) })
    }
  }

  // ── read face ──────────────────────────────────────────────────────────

  /** Full catalog snapshot, enriched with per-section metadata and store paths. */
  getCatalog() {
    const rules = this.activeRules
    const overriddenBy = new Map()
    if (rules !== null) for (const rule of rules) if (rule.action === 'replace') overriddenBy.set(rule.section, this.active)
    const sections = this.catalog.sections.map((section, index) => ({
      name: section.name,
      text: section.text,
      position: index + 1,
      owner: resolveOwner(section.name),
      overriddenBy: overriddenBy.get(section.name) ?? null
    }))
    return {
      ...this.catalog,
      sections,
      storeRoot: this.root,
      activePath: join(this.root, ACTIVE_FILENAME)
    }
  }

  /** Pipeline (幕布) snapshot for one real assembly. {sessionId, round} selects a
   *  session's round (0 = that session's latest); {index} selects globally. */
  async getPipeline(payload = {}) {
    let real = null
    let historyCount = 0
    let historyIndex = 0
    let sessionId = null
    const sessionParam = String(payload?.sessionId ?? '')
    if (sessionParam !== '') {
      const bucket = this.snapshotsBySession.get(sessionParam)
      if (bucket !== undefined) {
        sessionId = sessionParam
        historyCount = bucket.rounds.length
        const round = Number(payload?.round ?? 0)
        historyIndex = Number.isFinite(round) && round >= 0 && round < bucket.rounds.length ? round : 0
        real = bucket.rounds[bucket.rounds.length - 1 - historyIndex]
      }
    } else {
      const requested = Number(payload?.index ?? 0)
      const count = this.realSnapshots.length
      // index 0 = 最近一轮；index 越界时回退到可用的最旧轮
      const realIndex = Number.isFinite(requested) && requested >= 0 && requested < count ? count - 1 - requested : (count > 0 ? 0 : null)
      real = realIndex !== null ? this.realSnapshots[realIndex] : this.lastReal
      historyCount = count
      historyIndex = requested
    }
    const rules = this.activeRules
    const activePreset = this.active === null ? null : this.presets.get(this.active)
    const overrideOps = rules === null
      ? []
      : rules.map((rule) => ({
          action: rule.action,
          section: rule.section,
          presetName: this.active,
          presetFile: activePreset?.path ?? null
        }))
    const pristine = real !== null ? real.pristineSections : (this.catalog.pristineSections ?? this.catalog.sections)
    const applied = real !== null ? real.appliedSections : this.catalog.sections
    const variables = real !== null ? real.variables : this.catalog.variables
    const contexts = real !== null ? real.contexts : this.catalog.contexts
    const tools = real !== null ? real.tools : this.catalog.tools
    // 来源段生效状态：被激活预设 replace/remove 的段优先于空段判断
    const replacedNames = new Set()
    const removedNames = new Set()
    if (rules !== null) for (const rule of rules) {
      if (rule.action === 'replace') replacedNames.add(rule.section)
      else if (rule.action === 'remove') removedNames.add(rule.section)
    }
    const source = pristine.map((section, index) => {
      let status = 'active'
      if (removedNames.has(section.name)) status = 'removed'
      else if (replacedNames.has(section.name)) status = 'overridden'
      else if (section.text === '' || section.text === undefined || section.text === null) status = 'empty'
      return {
        name: section.name,
        text: section.text,
        orderHint: orderHintOf(section.name, index),
        source: resolveOwner(section.name),
        status
      }
    })
    const interpolated = applied.map((section) => ({
      name: section.name,
      text: interpolateText(section.text, variables)
    }))
    let rendered = this.catalog.rendered
    let contextRendered = ''
    try {
      const { joinContextSections, renderPrompt } = await import('@deepseek-ai/dsh-system-prompt')
      if (real !== null) rendered = renderPrompt({ sections: applied, contexts, tools, variables })
      contextRendered = joinContextSections(contexts)
    } catch (error) {
      if (rendered === '') rendered = `(render unavailable: ${String(error?.message ?? error)})`
    }
    return {
      ts: real !== null ? real.ts : this.catalog.ts,
      scope: real !== null ? 'agent' : 'global',
      active: this.active,
      sessionId: sessionId !== null ? sessionId : (real?.sessionId ?? null),
      cwd: real?.cwd ?? '',
      title: real?.title ?? '',
      userInput: real?.userInput ?? '',
      workspaceInstructions: real?.workspaceInstructions ?? '',
      workspaceFiles: real?.workspaceFiles ?? [],
      // 技能目录：pre-step 以 agent scope 权威枚举（与 tool-skill 同路径）；快照兜底
      skillsCatalog: real?.skillsCatalog ?? this.lastSkillsCatalog ?? '',
      variables,
      stages: { source, override: overrideOps, interpolated, contexts },
      // 工具 schema 定义（name + description）：供画布侧翼展示/展开查看
      tools: tools.map((tool) => ({
        name: typeof tool === 'string' ? tool : tool.name,
        description: typeof tool === 'string' ? '' : (tool.description ?? '')
      })),
      // 轮次时间轴元信息：总轮数 + 当前轮（index/round 0 = 最新）
      history: { count: historyCount, index: historyIndex },
      rendered,
      contextRendered
    }
  }

  /** 对话历史：本次运行期间见过的 session（按最近活动排序），供幕布右侧面板分类/加载。 */
  getHistory() {
    const sessions = []
    for (const bucket of this.snapshotsBySession.values()) {
      const last = bucket.rounds.length > 0 ? bucket.rounds[bucket.rounds.length - 1] : null
      sessions.push({
        sessionId: bucket.sessionId,
        cwd: bucket.cwd,
        title: bucket.title,
        roundCount: bucket.rounds.length,
        lastTs: last !== null ? last.ts : 0,
        roundsTs: bucket.rounds.map((r) => r.ts),
        roundsUserInputs: bucket.rounds.map((r) => r.userInput ?? ''),
        lastScope: last !== null ? 'agent' : 'global'
      })
    }
    sessions.sort((a, b) => b.lastTs - a.lastTs)
    return { sessions }
  }

  /** 翻译缓存文件路径（与预设同目录）。 */
  translationPath() {
    return join(this.root, 'translations.json')
  }

  /** 载入翻译缓存（进程内 Map，持久化文件）。 */
  loadTranslationCache() {
    if (this.translationCache !== null) return this.translationCache
    this.translationCache = new Map()
    const file = this.translationPath()
    if (existsSync(file)) {
      try {
        const raw = parseYaml(readFileSync(file, 'utf8')) ?? {}
        if (typeof raw === 'object') for (const [hash, entry] of Object.entries(raw)) this.translationCache.set(hash, entry)
      } catch { /* 缓存损坏时忽略，重新建立 */ }
    }
    return this.translationCache
  }

  /** 原子持久化翻译缓存。 */
  saveTranslationCache() {
    const doc = {}
    for (const [hash, entry] of this.translationCache) doc[hash] = entry
    const target = this.translationPath()
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8')
    renameSync(tmp, target)
  }

  /**
   * 翻译一段文本（默认中文），带持久化缓存。force=true 强制重新翻译。
   * 直连 DeepSeek API，key 复用 DSH 凭证服务（翻译为辅助功能，绕开 adapter 层）。
   */
  async translate(payload = {}) {
    const text = String(payload?.text ?? '')
    if (text.trim() === '') return { translated: '', cached: false, ts: 0 }
    const target = String(payload?.target ?? 'zh')
    const force = payload?.force === true
    const hash = createHash('sha1').update(text).digest('hex').slice(0, 24)
    const cache = this.loadTranslationCache()
    const entry = cache.get(hash)
    const cached = entry !== undefined && entry[target] !== undefined
    if (cached && !force) {
      return { translated: entry[target].text, cached: true, ts: entry[target].ts, hash }
    }
    // 未缓存或强制刷新：直连 DeepSeek API（key 复用 DSH 凭证服务），翻译辅助功能绕开 adapter 层
    const credentials = this.ctx.get('credentials')
    let apiKey = null
    if (credentials !== undefined) {
      try {
        // resolve() already layers the managed store, process env, and .env fallbacks.
        const resolved = await credentials.resolve('DEEPSEEK_API_KEY')
        apiKey = typeof resolved?.value === 'string' && resolved.value !== '' ? resolved.value : null
      } catch { /* 凭证解析失败 */ }
    }
    if (apiKey === null) throw new Error('translate: DEEPSEEK_API_KEY credential not available (请通过设置-模型页配置 DeepSeek API Key)')
    const model = String(payload?.model ?? 'deepseek-chat')
    const baseUrl = String(payload?.baseURL ?? 'https://api.deepseek.com')
    const targetLabel = target === 'zh' ? 'Simplified Chinese (zh-CN)' : target
    const prompt = `Translate the following text into ${targetLabel}. Preserve Markdown structure, code blocks, identifiers, inline code, and {{variable}} placeholders exactly. Return only the translation without commentary.\n\n${text}`
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [{ role: 'user', content: prompt }]
      })
    })
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      throw new Error(`translate: DeepSeek API HTTP ${res.status}: ${bodyText.slice(0, 200)}`)
    }
    const data = await res.json()
    const translated = String(data?.choices?.[0]?.message?.content ?? '').trim()
    if (translated === '') throw new Error('translate: empty model output from DeepSeek API')
    const now = Date.now()
    const nextEntry = { ...(cache.get(hash) ?? {}) }
    nextEntry[target] = { text: translated, ts: now }
    cache.set(hash, nextEntry)
    try {
      this.saveTranslationCache()
    } catch { /* 缓存写失败不阻断本次翻译 */ }
    return { translated, cached: false, ts: now, hash }
  }

  /** Preset list with the active marker, kind, and per-preset file paths. */
  listPresets() {
    return {
      active: this.active,
      storeRoot: this.root,
      activePath: join(this.root, ACTIVE_FILENAME),
      presets: [...this.presets.values()].map(({ name, label, description, overrides, kind, path }) => ({
        name,
        label,
        description,
        ruleCount: overrides.length,
        kind,
        path
      }))
    }
  }

  /** One normalized preset (with kind/path), or null. */
  getPreset(presetName) {
    return this.presets.get(presetName) ?? null
  }

  /** Raw YAML text of one preset file (for the client-side editor). */
  getPresetYaml(presetName) {
    const preset = this.presets.get(presetName)
    if (preset === undefined) throw new Error(`preset "${presetName}" does not exist`)
    return readFileSync(preset.path, 'utf8')
  }

  /**
   * Preview where a DRAFT preset's overrides would land in the render order,
   * without saving or activating anything. The draft is applied with the same
   * applyPreset logic the runtime uses, so the predicted positions match what
   * the model would receive.
   *
   * Base: the last REAL agent assembly's pristine (pre-preset) sections — the
   * same base the 幕布 shows for the current session (includes the tool 与 plan
   * 命名空间段 the agent actually renders). Falls back to the global catalog
   * (scope-less) when no real assembly exists yet.
   * @param payload - { overrides: raw rule list } (same shape as preset overrides).
   * @returns pristine/applied ordered name lists with draft/removed markers,
   *          or { error } when the draft rules are invalid (client shows it live).
   */
  previewPreset(payload = {}) {
    const raw = Array.isArray(payload?.overrides) ? payload.overrides : []
    let rules
    try {
      rules = normalizePreset({ label: 'preview-draft', description: '', overrides: raw }, 'preview-draft').overrides
    } catch (error) {
      return { error: String(error?.message ?? error) }
    }
    const agentBase = this.lastReal !== null && this.lastReal !== undefined ? this.lastReal.pristineSections : null
    const base = agentBase ?? (this.catalog.pristineSections ?? this.catalog.sections)
    const pristine = base.map((section, index) => ({ name: section.name, position: index + 1 }))
    const draftNames = new Set(rules.filter((rule) => rule.action !== 'remove').map((rule) => rule.section))
    const removedNames = new Set(rules.filter((rule) => rule.action === 'remove').map((rule) => rule.section))
    const applied = applyPresetKeyed(base, rules)
      .map(({ section, key }, index) => ({
        name: section.name,
        position: index + 1,
        key,
        draft: draftNames.has(section.name),
        removed: removedNames.has(section.name)
      }))
    return {
      active: this.active,
      baseScope: agentBase !== null ? 'agent' : 'global',
      pristine,
      applied,
      draftCount: draftNames.size,
      removedCount: removedNames.size
    }
  }

  /** Parse, validate, and persist a preset from raw YAML text (create or replace). */
  updatePresetYaml(presetName, yaml) {
    if (!PRESET_NAME_RE.test(presetName)) throw new Error(`invalid preset name "${presetName}" (must match ${PRESET_NAME_RE})`)
    const existing = this.presets.get(presetName)
    if (existing !== undefined && existing.kind === 'builtin') throw new Error(`preset "${presetName}" is built-in and read-only (save a copy as a personalized preset instead)`)
    let raw
    try {
      raw = parseYaml(yaml)
    } catch (error) {
      throw new Error(`preset "${presetName}": YAML parse failed: ${String(error?.message ?? error)}`)
    }
    if (raw === undefined || raw === null) raw = {}
    const preset = normalizePreset(raw, presetName)
    this.writePresetFile(presetName, preset)
    return this.getPreset(presetName)
  }

  // ── write face ─────────────────────────────────────────────────────────

  /** Create a user preset (fails when the name is invalid or a same-name user preset exists). */
  createPreset(payload) {
    const name = String(payload?.name ?? '')
    if (!PRESET_NAME_RE.test(name)) throw new Error(`invalid preset name "${name}" (must match ${PRESET_NAME_RE})`)
    const existing = this.presets.get(name)
    if (existing !== undefined && existing.kind === 'user') throw new Error(`preset "${name}" already exists`)
    const doc = {
      label: payload?.label !== undefined && payload.label !== '' ? String(payload.label) : name,
      description: payload?.description !== undefined ? String(payload.description) : '',
      overrides: Array.isArray(payload?.overrides) ? payload.overrides : []
    }
    this.writePresetFile(name, normalizePreset(doc, name))
    return this.getPreset(name)
  }

  /** Replace a preset's document (create when missing; builtin presets are read-only). */
  updatePreset(payload) {
    const name = String(payload?.name ?? '')
    if (!PRESET_NAME_RE.test(name)) throw new Error(`invalid preset name "${name}"`)
    const existing = this.presets.get(name)
    if (existing !== undefined && existing.kind === 'builtin') throw new Error(`preset "${name}" is built-in and read-only (save a copy as a personalized preset instead)`)
    const doc = {
      label: payload?.label !== undefined ? String(payload.label) : existing?.label ?? name,
      description: payload?.description !== undefined ? String(payload.description) : existing?.description ?? '',
      overrides: payload?.overrides !== undefined ? payload.overrides : existing?.overrides ?? []
    }
    this.writePresetFile(name, normalizePreset(doc, name))
    return this.getPreset(name)
  }

  /** Delete a user preset; deactivates it when it was active. Builtin presets are read-only. */
  deletePreset(presetName) {
    const existing = this.presets.get(presetName)
    if (existing === undefined) throw new Error(`preset "${presetName}" does not exist`)
    if (existing.kind === 'builtin') throw new Error(`preset "${presetName}" is built-in and read-only`)
    rmSync(join(this.root, `${presetName}.yml`))
    if (this.active === presetName) this.setActive(null)
    this.reload()
    return { ok: true }
  }

  /** Activate a preset (name) or disable prompt management (null/''). */
  setActive(presetName) {
    const name = presetName === null || presetName === '' ? null : String(presetName)
    if (name !== null && !this.presets.has(name)) throw new Error(`preset "${name}" does not exist`)
    const doc = { active: name }
    const target = join(this.root, ACTIVE_FILENAME)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, dumpYaml(doc), 'utf8')
    renameSync(tmp, target)
    this.active = name
    this.ctx.emit('prompt-manager/presets-changed')
    return { active: name }
  }

  /** Persist one normalized preset atomically and reload. */
  writePresetFile(name, preset) {
    const doc = {
      label: preset.label === name ? undefined : preset.label,
      description: preset.description === '' ? undefined : preset.description,
      overrides: preset.overrides
    }
    const target = join(this.root, `${name}.yml`)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, dumpYaml(doc), 'utf8')
    renameSync(tmp, target)
    this.reload()
  }
}

/** Fold any thrown error into the RPC error branch (code 'internal'). */
function foldError(error) {
  return { ok: false, error: { code: 'internal', message: String(error?.message ?? error), details: {} } }
}

/** Dispatcher for the `<RPC_CHANNEL>/<method>` endpoints. */
async function handleRpc(manager, method, payload) {
  switch (method) {
    case 'getCatalog': return manager.getCatalog()
    case 'getPipeline': return manager.getPipeline(payload ?? {})
    case 'getHistory': return manager.getHistory()
    case 'translate': return manager.translate(payload ?? {})
    case 'listPresets': return manager.listPresets()
    case 'getPreset': return manager.getPreset(String(payload?.name ?? ''))
    case 'getPresetYaml': return manager.getPresetYaml(String(payload?.name ?? ''))
    case 'previewPreset': return manager.previewPreset(payload ?? {})
    case 'createPreset': return manager.createPreset(payload ?? {})
    case 'updatePreset': return manager.updatePreset(payload ?? {})
    case 'updatePresetYaml': return manager.updatePresetYaml(String(payload?.name ?? ''), String(payload?.yaml ?? ''))
    case 'deletePreset': return manager.deletePreset(String(payload?.name ?? ''))
    case 'setActive': return manager.setActive(String(payload?.name ?? ''))
    case 'refresh': { await manager.refreshCatalog(); return manager.getCatalog() }
    default: throw new Error(`unknown prompt-manager endpoint "${method}"`)
  }
}

/** Read a buffered JSON body, rejecting bodies above the channel cap. */
async function readRequestBody(req) {
  const chunks = []
  let received = 0
  for await (const chunk of req) {
    received += chunk.byteLength
    if (received > MAX_RPC_BODY_BYTES) {
      const error = new Error('rpc body too large')
      error.code = 'RPC_BODY_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Build the prefix route serving the client-request/server-response envelope.
 * Connection's auth hook applies the same Host/Origin fence and browser-session
 * check as `/api`; only the envelope handling lives here.
 */
function createRpcRoute(manager, connection) {
  return {
    kind: 'prefix',
    path: RPC_CHANNEL,
    handler: async (req, res) => {
      const admission = connection.admit(req)
      if ('rejection' in admission) {
        res.writeHead(admission.rejection)
        res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      if (admission.peer.principal.kind !== 'owner') {
        res.writeHead(403)
        res.end('forbidden')
        return
      }
      const pathname = new URL(req.url ?? '/', 'http://dsh.internal').pathname
      const endpoint = pathname.startsWith(`${RPC_CHANNEL}/`) ? pathname.slice(RPC_CHANNEL.length + 1) : ''
      if (req.method !== 'POST' || !RPC_ENDPOINT_RE.test(endpoint)) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      if ((req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
        res.writeHead(415)
        res.end('content type must be application/json')
        return
      }
      let body
      try {
        body = JSON.parse(await readRequestBody(req))
      } catch (error) {
        if (error?.code === 'RPC_BODY_TOO_LARGE') {
          res.writeHead(413, { connection: 'close' })
          res.end()
          req.destroy()
          return
        }
        res.writeHead(400)
        res.end('body is not JSON')
        return
      }
      const rpcId = typeof body?.rpcId === 'string' ? body.rpcId : 'invalid-request'
      const respond = (result) => {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(JSON.stringify({ type: 'server-response', rpcId, result }))
      }
      if (body?.type !== 'client-request' || typeof body?.rpcId !== 'string' || typeof body?.method !== 'string') {
        respond({ ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: {} } })
        return
      }
      if (body.method !== endpoint) {
        respond({ ok: false, error: { code: 'gateway/bad-request', message: `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`, details: {} } })
        return
      }
      try {
        respond({ ok: true, value: await handleRpc(manager, endpoint, body.payload) })
      } catch (error) {
        respond(foldError(error))
      }
    }
  }
}

/**
 * Cordis plugin body: mount the service, the assembly waterfall hook, the
 * agent tools, and the dedicated Connection RPC channel.
 * @param ctx - the host context.
 * @param config - the prompt-manager row config.
 */
export function apply(ctx, config) {
  const manager = new PromptManager(ctx, config)

  // Hook: apply the active preset after every cooperative assembly. The
  // pristine assembly (pre-preset) is recorded for the catalog view; when the
  // assembly belongs to a real agent step (context.agent set), the snapshot is
  // kept for the pipeline (幕布) view with real variable values.
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    manager.lastPristine = { ...assembly, sections: [...assembly.sections], contexts: [...assembly.contexts] }
    // Catalog refresh marks its own call so its pristine lands in a dedicated
    // slot (agent-scoped assembles overwrite `lastPristine` concurrently).
    if (context?.__catalogRefresh === true) {
      manager.lastCatalogPristine = [...assembly.sections]
    }
    const result = await next()
    const rules = manager.activeRules
    const applied = (rules === null || rules.length === 0)
      ? result
      : { ...result, sections: applyPreset(result.sections, rules) }
    manager.lastApplied = applied
    if (context?.agent !== undefined) {
      const session = context.agent.session
      const sessionId = session?.id ?? 'unknown'
      const cwd = session?.header?.cwd ?? ''
      // 工作区指令：磁盘读取兜底（确定性展示源）；pre-step 消息路径捕获的
      // 组合文本仍优先生效（模型实际看到的 <system-reminder> 包装）。
      const diskWI = readWorkspaceInstructions(cwd)
      const snapshot = {
        pristineSections: [...assembly.sections],
        appliedSections: [...applied.sections],
        contexts: [...applied.contexts],
        tools: applied.tools,
        variables: { ...applied.variables },
        sessionId,
        cwd,
        title: session?.header?.title ?? '',
        userInput: manager.lastUserInput ?? '',
        workspaceInstructions: (manager.lastWorkspaceInstructions || diskWI.text) || '',
        workspaceFiles: diskWI.found ? diskWI.files : [],
        skillsCatalog: manager.lastSkillsCatalog ?? '',
        ts: Date.now()
      }
      manager.lastReal = snapshot
      // 轮次快照环形缓冲：保留最近 REAL_SNAPSHOT_LIMIT 轮真实组装
      manager.realSnapshots.push(snapshot)
      if (manager.realSnapshots.length > REAL_SNAPSHOT_LIMIT) manager.realSnapshots.shift()
      // 对话历史：按 session 分组，每个 session 保留最近 SESSION_ROUND_LIMIT 轮
      let bucket = manager.snapshotsBySession.get(sessionId)
      if (bucket === undefined) {
        bucket = { sessionId, cwd: session?.header?.cwd ?? '', title: session?.header?.title ?? '', rounds: [] }
        manager.snapshotsBySession.set(sessionId, bucket)
      } else {
        bucket.cwd = session?.header?.cwd ?? bucket.cwd
        bucket.title = session?.header?.title ?? bucket.title
      }
      bucket.rounds.push(snapshot)
      if (bucket.rounds.length > SESSION_ROUND_LIMIT) bucket.rounds.shift()
      // session 数超限：丢最久未活动的（rounds 最早 ts 最小的）
      while (manager.snapshotsBySession.size > SESSION_LIMIT) {
        let oldestKey = null
        let oldestTs = Infinity
        for (const [key, b] of manager.snapshotsBySession) {
          const last = b.rounds.length > 0 ? b.rounds[b.rounds.length - 1].ts : 0
          if (last < oldestTs) { oldestTs = last; oldestKey = key }
        }
        if (oldestKey !== null) manager.snapshotsBySession.delete(oldestKey)
        else break
      }
    }
    return applied
  })

  // 用户输入捕获：agent/pre-step 的 claimed 消息 = 该轮用户输入；它随后与
  // runtime-context 快照一起作为 user-role 消息写入历史并随请求发送。
  ctx.on('agent/pre-step', async (payload, next) => {
    const result = await next()
    try {
      const messages = payload?.messages ?? []
      const texts = []
      const extractText = (value) => {
        if (value === null || value === undefined) return ''
        if (typeof value === 'string') return value
        if (Array.isArray(value)) return value.map(extractText).filter((t) => t !== '').join('')
        if (typeof value === 'object') {
          if (typeof value.text === 'string') return value.text
          if (value.content !== undefined) return extractText(value.content)
          return ''
        }
        return ''
      }
      for (const message of messages) {
        const text = extractText(message?.content ?? message?.text ?? '')
        if (text.trim() !== '') texts.push(text)
      }
      // 只在确实读到用户消息时更新：后续步骤 claimed=[] 时不能把上次的用户输入覆盖成空串
      if (texts.length > 0) {
        manager.lastUserInput = texts.join('\n')
        if (manager.lastReal !== null) manager.lastReal.userInput = manager.lastUserInput
      }
      // 注入消息捕获：AGENTS.md 工作区指令（source.kind='agent-instructions'）与技能目录（source.kind='skill-catalog'）。
      // 二者由 dsh-agent-instructions / dsh-tool-skill 在 pre-step waterfall 内注入 decision.messages；
      // 未注入的轮次保留最近一次的值。
      const decisionMessages = result?.messages ?? []
      let workspaceInstructions = null
      let skillsCatalog = null
      for (const message of decisionMessages) {
        const source = message?.source
        const text = extractText(message?.content ?? '')
        if (source?.kind === 'agent-instructions' && text.trim() !== '') workspaceInstructions = text
        else if (source?.kind === 'skill-catalog' && text.trim() !== '') skillsCatalog = text
      }
      if (workspaceInstructions !== null) {
        manager.lastWorkspaceInstructions = workspaceInstructions
        if (manager.lastReal !== null) manager.lastReal.workspaceInstructions = workspaceInstructions
      }
      if (skillsCatalog !== null) {
        manager.lastSkillsCatalog = skillsCatalog
        if (manager.lastReal !== null) manager.lastReal.skillsCatalog = skillsCatalog
      }
      // 技能目录兜底：本轮没有捕获到 tool-skill 注入的目录消息时，才用 agent
      // scope 枚举 ctx.skills 重建（有捕获时以消息原文为准——0.2 会按 digest
      // 复用目录或发“替换目录”消息，重渲染可能与之不一致）。
      if (skillsCatalog === null) {
        try {
          const agent = payload?.agent
          const skillsSvc = ctx.get('skills')
          if (agent !== undefined && skillsSvc !== undefined) {
            const snap = await skillsSvc.snapshot({
              scope: agent,
              cwd: agent.session?.header?.cwd
            })
            if (snap.complete) {
              const lines = []
              for (const skill of snap.skills) {
                if (!isModelInvocable(skill)) continue
                lines.push(`- \`${skill.name}\`: ${skill.description ?? ''}`)
              }
              const text = [
                '<system-reminder>',
                'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
                '',
                '<available_skills>',
                ...lines,
                '</available_skills>',
                '',
                "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
                '</system-reminder>'
              ].join('\n')
              manager.lastSkillsCatalog = text
              if (manager.lastReal !== null) manager.lastReal.skillsCatalog = text
            }
          }
        } catch { /* 技能枚举失败时保留消息路径捕获 */ }
      }
    } catch { /* 消息结构变化时忽略 */ }
    return result
  })

  // 捕获 agent 真实请求配置（provider/model/sessionId），供翻译复用同一路由
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    try {
      const request = resolved ?? payload?.request
      if (request !== null && request !== undefined) {
        manager.lastRequestConfig = {
          provider: request.provider,
          model: request.model,
          sessionId: request.sessionId
        }
      }
    } catch { /* 结构变化时忽略 */ }
    return resolved
  })

  // Catalog: refresh on any prompt registration change AND on preset changes
  // (activation/edits), so snapshots and rendered previews always reflect the
  // currently effective assembly.
  ctx.on('system-prompt/change', () => { void manager.refreshCatalog() })
  ctx.on('prompt-manager/presets-changed', () => { void manager.refreshCatalog() })
  void manager.refreshCatalog()

  // Agent tools.
  ctx.tools.register(defineTool({
    name: 'switch_prompt',
    description: 'Switch the active prompt preset (a named set of system-prompt overrides) or turn prompt management off. Changes apply to the next model step. Use list_prompts to see available presets.',
    parameters: {
      preset: { type: 'string', description: 'Preset name to activate; omit together with off=false to keep the current preset.' },
      off: { type: 'boolean', description: 'true disables prompt management for the next steps.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          active: { type: 'string' },
          presets: { type: 'array', items: { type: 'string' } }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.active === null ? 'Prompt management disabled.' : `Active prompt preset: ${value.active}.` }]
    },
    execute(args) {
      const off = args.off === true
      const preset = off ? null : (args.preset ?? manager.active)
      const result = manager.setActive(preset)
      return Promise.resolve({ active: result.active, presets: [...manager.presets.keys()] })
    }
  }))

  ctx.tools.register(defineTool({
    name: 'list_prompts',
    description: 'List prompt presets, the active one, and the current catalog of system-prompt sections (name + text) so you can see exactly what the model receives.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          active: { type: 'string' },
          presets: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                label: { type: 'string', required: true },
                ruleCount: { type: 'integer', required: true }
              }
            }
          },
          sections: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                name: { type: 'string', required: true },
                text: { type: 'string', required: true }
              }
            }
          }
        }
      },
      render: (_args, value) => [{ type: 'text', text: `Presets: ${value.presets.map((p) => p.name).join(', ') || '(none)'}; active: ${value.active ?? '(none)'}; sections: ${value.sections.length}` }]
    },
    execute() {
      const list = manager.listPresets()
      return Promise.resolve({
        active: list.active,
        presets: list.presets,
        sections: manager.catalog.sections
      })
    }
  }))

  ctx.tools.register(defineTool({
    name: 'get_prompt',
    description: 'Read the current text of one system-prompt section by name (e.g. deployment:persona-prefix, harness:identity, plan:policy). Returns null when the section is not present in the global catalog.',
    parameters: {
      section: { type: 'string', required: true, description: 'Section name to read.' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string', required: true },
          text: { type: 'string' }
        }
      },
      render: (_args, value) => [{ type: 'text', text: value.text === null ? `Section ${value.name}: not present.` : `Section ${value.name}:\n${value.text}` }]
    },
    execute(args) {
      const section = manager.catalog.sections.find((entry) => entry.name === args.section)
      return Promise.resolve({ name: args.section, text: section === undefined ? null : section.text })
    }
  }))

  ctx.tools.register(defineTool({
    name: 'save_prompt',
    description: 'Persist the current text of one system-prompt section as a replace rule of a prompt preset (creating the preset when needed), so an optimized prompt is kept and can be switched to later. Use get_prompt to read the current text first.',
    parameters: {
      section: { type: 'string', required: true, description: 'Section name the rule targets.' },
      text: { type: 'string', required: true, description: 'Replacement text to save.' },
      preset: { type: 'string', description: 'Target preset name; defaults to "custom".' }
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          preset: { type: 'string', required: true },
          section: { type: 'string', required: true },
          ruleCount: { type: 'integer', required: true }
        }
      },
      render: (_args, value) => [{ type: 'text', text: `Saved ${value.section} into preset ${value.preset} (${value.ruleCount} rules).` }]
    },
    execute(args) {
      const presetName = args.preset ?? 'custom'
      let preset = manager.getPreset(presetName)
      if (preset === null || preset.kind === 'builtin') {
        // builtin presets are read-only: create a personalized shadow preset
        preset = manager.createPreset({ name: presetName })
      }
      const overrides = [...preset.overrides.filter((rule) => rule.section !== args.section), { action: 'replace', section: args.section, text: args.text }]
      manager.updatePreset({ name: presetName, overrides })
      return Promise.resolve({ preset: presetName, section: args.section, ruleCount: overrides.length })
    }
  }))

  // Dedicated RPC channel for the web client half and the pipeline page.
  // `/api` is owned by the dsh API gateway in 0.2, so the plugin mounts its own
  // prefix route and asks Connection to apply the same Host/Origin + browser
  // authentication fence. (`connection.rpc.handle` currently resolves the
  // channel owner against the provider fiber, which cannot see the consumer's
  // `webServer`; the Fetch route below uses the documented auth hook instead.)
  ctx.inject(['connection', 'webServer'], (connectionCtx) => {
    connectionCtx.effect(
      () => connectionCtx.webServer.register(createRpcRoute(manager, connectionCtx.connection)),
      'prompt-manager: rpc channel'
    )
  })

  // Standalone full-screen pipeline page (幕布): /prompt-manager/pipeline.
  // Served by the host web server so the pipeline page gets the whole window
  // instead of the settings panel; the page fetches getPipeline over the
  // dedicated RPC channel. 页面每次请求实时读文件（不缓存），开发期改
  // pipeline.html 无需重启 dsh web。路由名取数据语义（pipeline/幕布），
  // 不取渲染形态（canvas）——形态可变、语义稳定，见 docs/DESIGN.md §15.5e。
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.webServer.register({
      kind: 'exact',
      path: '/prompt-manager/pipeline',
      handler: (req, res) => {
        try {
          const pageHtml = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'pipeline.html'), 'utf8')
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
          res.end(pageHtml)
        } catch (error) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' })
          res.end(`failed to load pipeline page: ${String(error?.message ?? error)}`)
        }
      }
    })
  })
}
