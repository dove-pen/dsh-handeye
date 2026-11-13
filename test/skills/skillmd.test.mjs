import test from 'node:test'
import assert from 'node:assert/strict'

import {
  slugify,
  exportSkillMarkdown,
  importSkillMarkdown,
  parseFrontmatter,
} from '../../src/skills/skillmd.js'

const NAME_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/

function sampleSkill(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'skill_20261108_01',
    title: '订阅一个邮件通讯',
    version: 3,
    origin: { kind: 'episode', episodeIds: ['a'], createdAt: '2026-11-08T00:00:00Z', author: 'local' },
    params: [{ name: 'url', required: true, example: 'https://a.example' }],
    steps: [
      {
        id: 's1',
        intent: '打开 {{url}}',
        tool: 'browser_navigate',
        args: { url: '{{url}}' },
        anchor: { kind: 'navigate', text: '', container: 'Chrome', point: null, fragile: false, source: 'output.window' },
        expect: { type: 'screen', appear: '订阅' },
        onFail: 'stop',
      },
      { id: 's2', intent: '点免费订阅', tool: 'hand_click_text', args: { text: '免费订阅' }, anchor: null, expect: null, onFail: 'stop' },
    ],
    health: { runs: 2, ok: 1, fail: 1, failsInRow: 0, lastRunAt: '2026-11-08T01:00:00Z', lastFailReason: '按钮没找到', status: 'needs-review' },
    incomplete: { stepsWithoutChecks: 1, fragileSteps: 0 },
    ...overrides,
  }
}

// ---------------------------------------------------------------- slug

test('slugify produces a spec-compliant name', () => {
  assert.equal(slugify('Clean Downloads Folder'), 'clean-downloads-folder')
  assert.match(slugify('订阅一个邮件通讯', 'skill_20261108_01'), NAME_RE)
  assert.equal(slugify('订阅一个邮件通讯', 'skill_20261108_01'), 'skill-20261108-01')
  assert.equal(slugify('--weird--name--', 'x_y_z'), 'weird-name')
})

test('slug never exceeds 64 chars and never starts/ends with a hyphen', () => {
  const long = 'a'.repeat(120)
  const name = slugify(long, 'fallback')
  assert.ok(name.length <= 64)
  assert.match(name, NAME_RE)
})

// ---------------------------------------------------------------- export

test('exported SKILL.md has spec-compliant frontmatter', () => {
  const out = exportSkillMarkdown(sampleSkill())
  const md = out.files.find((f) => f.path === 'SKILL.md').content
  assert.match(md, /^---\n/)
  const parsed = parseFrontmatter(md)
  assert.equal(parsed.ok, true, parsed.error)
  assert.match(parsed.data.name, NAME_RE)
  assert.ok(parsed.data.description.length <= 1024)
  assert.equal(parsed.data.metadata['handeye.id'], 'skill_20261108_01')
  assert.equal(parsed.data.metadata['handeye.version'], '3')
})

test('the body is readable by a human and carries the machine block', () => {
  const out = exportSkillMarkdown(sampleSkill())
  const md = out.files.find((f) => f.path === 'SKILL.md').content
  assert.match(md, /# 订阅一个邮件通讯/)
  assert.match(md, /## Steps/)
  assert.match(md, /1\. \*\*打开 \{\{url\}\}\*\*/)
  assert.match(md, /订阅/)
  assert.match(md, /```json/)
})

test('expect referencing a local script is bundled under scripts/', () => {
  const skill = sampleSkill({
    steps: [
      {
        id: 's1',
        intent: '核对合计',
        tool: 'desk_text',
        args: {},
        anchor: null,
        expect: { type: 'exit', command: 'node "D:\\proj\\packs\\accounting\\checks\\total.mjs" a.csv --total 1' },
        onFail: 'stop',
      },
    ],
  })
  const out = exportSkillMarkdown(skill)
  const script = out.files.find((f) => f.path.startsWith('scripts/'))
  assert.ok(script, '脚本应该被带上')
  assert.equal(script.path, 'scripts/total.mjs')
  assert.match(script.from, /total\.mjs$/)
})

// ---------------------------------------------------------------- import

test('round trip: export then import keeps steps and params', () => {
  const original = sampleSkill()
  const md = exportSkillMarkdown(original).files.find((f) => f.path === 'SKILL.md').content
  const imported = importSkillMarkdown(md)
  assert.equal(imported.ok, true, imported.error)
  assert.equal(imported.skill.id, original.id)
  assert.equal(imported.skill.title, original.title)
  assert.equal(imported.skill.version, original.version)
  assert.deepEqual(imported.skill.params, original.params)
  assert.deepEqual(imported.skill.steps, original.steps)
  assert.equal(imported.warnings.length, 0)
})

test('a foreign SKILL.md without a machine block becomes a manual one-step skill', () => {
  const foreign = [
    '---',
    'name: "pdf-invoice-tidy"',
    'description: "把发票 PDF 按月份归档"',
    '---',
    '',
    '# PDF invoice tidy',
    '',
    '1. 读文件',
    '2. 按日期分组',
  ].join('\n')
  const imported = importSkillMarkdown(foreign)
  assert.equal(imported.ok, true)
  assert.equal(imported.skill.steps.length, 1)
  assert.equal(imported.skill.steps[0].expect, null)
  assert.match(imported.warnings[0], /no machine-readable block/)
})

test('missing name or description is refused with a clear reason', () => {
  assert.match(importSkillMarkdown('---\ndescription: "x"\n---\n').error, /missing name/)
  assert.match(importSkillMarkdown('---\nname: "x"\n---\n').error, /missing description/)
  assert.match(importSkillMarkdown('no frontmatter here').error, /frontmatter/)
})

test('a broken machine block degrades to manual instead of failing', () => {
  const md = ['---', 'name: "x"', 'description: "y"', '---', '', '```json', '{ not json }', '```'].join('\n')
  const imported = importSkillMarkdown(md)
  assert.equal(imported.ok, true)
  assert.match(imported.warnings.join(' '), /failed to parse/)
  assert.equal(imported.skill.steps.length, 1)
})

test('frontmatter parser handles a one-level metadata map', () => {
  const parsed = parseFrontmatter(['---', 'name: "a"', 'metadata:', '  handeye.id: "skill_x"', '---', 'body'].join('\n'))
  assert.equal(parsed.ok, true)
  assert.equal(parsed.data.metadata['handeye.id'], 'skill_x')
  assert.equal(parsed.body.trim(), 'body')
})
