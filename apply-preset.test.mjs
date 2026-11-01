// Unit tests for applyPreset / normalizePreset (rendering priority semantics).
// Run: node apply-preset.test.mjs
import assert from 'node:assert/strict'
import { applyPreset, applyPresetKeyed, normalizePreset } from './index.js'

const BASE = [
  { name: 'harness:identity', text: 'identity' },
  { name: 'harness:source', text: 'source' },
  { name: 'app:web-surface', text: 'web' },
  { name: 'deployment:persona-prefix', text: 'persona' },
  { name: 'tool:read', text: 'read' }
]
const names = (sections) => sections.map((s) => s.name)
const norm = (rules) => normalizePreset({ label: 't', description: '', overrides: rules }, 't').overrides

// 1. 无 order：纯锚点语义（历史行为不变）
{
  const out = applyPreset(BASE, norm([
    { action: 'insert', section: 'sec:a', after: 'harness:identity', text: 'A' },
    { action: 'insert', section: 'sec:z', text: 'Z' }
  ]))
  assert.deepEqual(names(out), ['harness:identity', 'sec:a', 'harness:source', 'app:web-surface', 'deployment:persona-prefix', 'tool:read', 'sec:z'])
}

// 2. top/order -2000 → 压倒一切，排在 harness:identity 之前
{
  const out = applyPreset(BASE, norm([{ action: 'insert', section: 'sec:top', text: 'T', order: -2000 }]))
  assert.equal(out[0].name, 'sec:top')
}

// 3. normalizePreset: top: true → TOP_ORDER (-2000)
{
  const r = norm([{ action: 'insert', section: 'sec:t2', text: 'T', top: true }])
  assert.equal(r[0].order, -2000)
}

// 4. 小数 order → 落在对应区间（index 代理）
{
  const out = applyPreset(BASE, norm([{ action: 'insert', section: 'sec:m', text: 'M', order: 2.5 }]))
  // index 0,1,2,3,4 → 2.5 落在 index2(app:web-surface) 与 index3(persona) 之间
  assert.deepEqual(names(out), ['harness:identity', 'harness:source', 'app:web-surface', 'sec:m', 'deployment:persona-prefix', 'tool:read'])
}

// 5. order 与 after 同时给出：order 胜出（重排）
{
  const out = applyPreset(BASE, norm([{ action: 'insert', section: 'sec:x', text: 'X', after: 'deployment:persona-prefix', order: 1.5 }]))
  assert.deepEqual(names(out), ['harness:identity', 'harness:source', 'sec:x', 'app:web-surface', 'deployment:persona-prefix', 'tool:read'])
}

// 6. 混合：无 order 的插入保持锚点位置，有 order 的跳位
{
  const out = applyPreset(BASE, norm([
    { action: 'insert', section: 'sec:anchored', text: 'A', after: 'harness:identity' },
    { action: 'insert', section: 'sec:jump', text: 'J', order: -2000 }
  ]))
  assert.deepEqual(names(out), ['sec:jump', 'harness:identity', 'sec:anchored', 'harness:source', 'app:web-surface', 'deployment:persona-prefix', 'tool:read'])
}

// 7. replace 携带 order → 该段整体移动
{
  const out = applyPreset(BASE, norm([{ action: 'replace', section: 'deployment:persona-prefix', text: 'NEW', order: -2000 }]))
  assert.equal(out[0].name, 'deployment:persona-prefix')
  assert.equal(out[0].text, 'NEW')
}

// 8. remove 正常 + 剩余保持相对顺序
{
  const out = applyPreset(BASE, norm([{ action: 'remove', section: 'tool:read' }]))
  assert.deepEqual(names(out), ['harness:identity', 'harness:source', 'app:web-surface', 'deployment:persona-prefix'])
}

// 9. 基础数组不被修改（纯函数）
{
  const before = JSON.stringify(BASE)
  applyPreset(BASE, norm([{ action: 'insert', section: 'sec:n', text: 'N', order: -2000 }]))
  assert.equal(JSON.stringify(BASE), before)
}

// 10. 两个置顶：稳定排序保持规则顺序
{
  const out = applyPreset(BASE, norm([
    { action: 'insert', section: 'sec:first', text: '1', top: true },
    { action: 'insert', section: 'sec:second', text: '2', top: true }
  ]))
  assert.deepEqual(names(out.slice(0, 2)), ['sec:first', 'sec:second'])
}

// 11. applyPresetKeyed：返回与排序一致的精确 key（拖拽取中点用）
{
  const keyed = applyPresetKeyed(BASE, norm([{ action: 'insert', section: 'sec:m', text: 'M', order: 2.5 }]))
  const byName = Object.fromEntries(keyed.map(({ section, key }) => [section.name, key]))
  assert.equal(byName['sec:m'], 2.5)
  assert.equal(byName['harness:identity'], 0)
  assert.equal(byName['harness:source'], 1)
  assert.equal(byName['app:web-surface'], 2)
  assert.equal(byName['deployment:persona-prefix'], 3)
  assert.equal(byName['tool:read'], 4)
  // 中点：2.5 与 3 之间 → 2.75，应落在 sec:m 与 persona 之间
  const mid = applyPreset(BASE, norm([
    { action: 'insert', section: 'sec:m', text: 'M', order: 2.5 },
    { action: 'insert', section: 'sec:n', text: 'N', order: (2.5 + 3) / 2 }
  ]))
  assert.deepEqual(names(mid), ['harness:identity', 'harness:source', 'app:web-surface', 'sec:m', 'sec:n', 'deployment:persona-prefix', 'tool:read'])
}

// 12. 无 order 时 keys = 数组下标（顺序保持）
{
  const keyed = applyPresetKeyed(BASE, [])
  assert.deepEqual(keyed.map((k) => k.key), [0, 1, 2, 3, 4])
}

console.log('applyPreset / applyPresetKeyed / normalizePreset: 12 项断言全部通过 ✓')
