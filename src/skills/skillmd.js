// SKILL.md 互操作：把内部技能 JSON 和 Agent Skills 标准格式互相转换。
//
// 标准见 https://agentskills.io/specification ：
//   一个技能 = 一个目录，必须有 SKILL.md（YAML frontmatter + Markdown 正文）；
//   frontmatter 必填 name / description，可选 license / compatibility / metadata / allowed-tools。
//
// 我们的做法：**正文写给人看**（模型/别人能照着做），**再附一段机器可读 JSON**
// （我们自己 import 时优先用它，保证往返不丢东西）。别的客户端不认识那段 JSON 也没关系，
// 它们读正文一样能干活。

const MAX_NAME = 64
const MAX_DESCRIPTION = 1024
const MAX_COMPATIBILITY = 500

/** 把标题转成符合规范的 name：小写、字母数字、连字符。中文标题转不出来就回落到 id。 */
export function slugify(title, fallback) {
  const ascii = String(title ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_NAME)
  const candidate = ascii.length >= 3 ? ascii : String(fallback ?? 'skill').replace(/_/g, '-').toLowerCase()
  return candidate.slice(0, MAX_NAME).replace(/^-+|-+$/g, '')
}

function yamlValue(value) {
  // JSON 字符串本身就是合法的 YAML 双引号标量，省掉手写转义
  return JSON.stringify(String(value ?? ''))
}

function describeSkill(skill) {
  const stepCount = (skill.steps ?? []).length
  const params = (skill.params ?? []).map((p) => p.name).filter(Boolean)
  const bits = [`${skill.title} (${stepCount} steps)`]
  if (params.length) bits.push(`Params: ${params.join(', ')}`)
  bits.push('Compiled from HandEye run records; just follow the steps.')
  return bits.join('；').slice(0, MAX_DESCRIPTION)
}

/** 内部技能 → SKILL.md 目录文件。 */
export function exportSkillMarkdown(skill) {
  const warnings = []
  const name = slugify(skill.title, skill.id)
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(name) || name.length > MAX_NAME) {
    warnings.push(`name "${name}" is invalid (lowercase letters/digits/hyphens, max ${MAX_NAME})`)
  }

  const params = skill.params ?? []
  const steps = skill.steps ?? []

  const stepLines = steps.map((step, index) => {
    const args = step.args && Object.keys(step.args).length ? `, args \`${JSON.stringify(step.args)}\`` : ''
    const expect = step.expect
      ? `. Check: ${describeCheck(step.expect)}`
      : '. **No machine check on this step** - confirm it yourself'
    return `${index + 1}. **${step.intent ?? step.tool ?? 'unnamed step'}** — tool \`${step.tool ?? '?'}\`${args}${expect}`
  })

  const paramLines = params.length
    ? params.map((p) => `- \`{{${p.name}}}\`${p.required ? ' (required)' : ' (optional)'}${p.example ? `, e.g. \`${p.example}\`` : ''}`)
    : ['(no params)']

  const machine = {
    schemaVersion: 1,
    id: skill.id,
    title: skill.title,
    version: skill.version ?? 1,
    params,
    steps,
    health: skill.health ?? null,
    origin: skill.origin ?? null,
    incomplete: skill.incomplete ?? null,
  }

  const body = [
    `# ${skill.title}`,
    '',
    describeSkill(skill),
    '',
    '## When to use',
    '',
    `Use this when the user wants to do something like "${skill.title}"; follow the steps below in order.`,
    '',
    '## Params',
    '',
    ...paramLines,
    '',
    '## Steps',
    '',
    ...(stepLines.length ? stepLines : ['(no steps)']),
    '',
    '## Notes',
    '',
    '- After each step, verify the check before moving on; if it fails, stop and explain instead of trying random workarounds.',
    '- Ask the user before deleting or overwriting anything.',
    '',
    '## Machine-readable steps',
    '',
    'The block below is for the HandEye plugin to read back; other clients can ignore it.',
    '',
    '```json',
    JSON.stringify(machine, null, 2),
    '```',
    '',
  ].join('\n')

  const front = [
    '---',
    `name: ${yamlValue(name)}`,
    `description: ${yamlValue(describeSkill(skill))}`,
    skill.origin?.author ? `license: ${yamlValue('MIT')}` : `license: ${yamlValue('MIT')}`,
    `compatibility: ${yamlValue('Windows; Node >= 20; desktop automation needs foreground window access')}`,
    'metadata:',
    `  handeye.id: ${yamlValue(skill.id)}`,
    `  handeye.version: ${yamlValue(String(skill.version ?? 1))}`,
    `  handeye.author: ${yamlValue(skill.origin?.author ?? 'local')}`,
    `  handeye.createdAt: ${yamlValue(skill.origin?.createdAt ?? '')}`,
    '---',
    '',
  ].join('\n')

  const files = [{ path: 'SKILL.md', content: front + body }]

  // 判据里引用的本地脚本一并带上（把绝对路径改写成 scripts/<名字>）
  const scripts = new Map()
  for (const step of steps) {
    const checks = Array.isArray(step.expect) ? step.expect : step.expect ? [step.expect] : []
    for (const check of checks) {
      if (check?.type !== 'exit' || typeof check.command !== 'string') continue
      const match = /node\s+"?([^"\s]+\.(?:mjs|cjs|js))"?/.exec(check.command)
      if (!match) continue
      const scriptPath = match[1]
      const base = scriptPath.split(/[\\/]/).pop()
      scripts.set(base, scriptPath)
    }
  }
  for (const base of scripts.keys()) {
    files.push({ path: `scripts/${base}`, from: scripts.get(base) })
  }
  if (scripts.size) {
    warnings.push('scripts referenced by checks are bundled as scripts/; confirm they can run in the new environment when importing')
  }

  return { name, files, warnings }
}

function describeCheck(expect) {
  const check = Array.isArray(expect) ? expect[0] : expect
  if (!check) return '(none)'
  if (check.type === 'file') return `file \`${check.path}\` exists${check.minBytes ? ` and >= ${check.minBytes} bytes` : ''}`
  if (check.type === 'text') return `${check.file ? `file \`${check.file}\`` : 'on screen'}${check.appear ? ` shows "${check.appear}"` : `不出现「${check.absent}」`}`
  if (check.type === 'screen') return `text "${check.appear}" appears on screen`
  if (check.type === 'exit') return `command \`${check.command}\` exits 0`
  if (check.type === 'changed') return 'screen changed'
  return check.type
}

/** 极简 frontmatter 解析：只认 `key: value` 与一层缩进的 map。 */
export function parseFrontmatter(text) {
  const source = String(text ?? '')
  if (!source.startsWith('---')) return { ok: false, error: 'SKILL.md must start with a YAML frontmatter block (---)' }
  const end = source.indexOf('\n---', 3)
  if (end < 0) return { ok: false, error: 'frontmatter has no closing ---' }
  const head = source.slice(3, end).replace(/^\r?\n/, '')
  const body = source.slice(source.indexOf('\n', end + 1) + 1)

  const data = {}
  let currentMap = null
  for (const rawLine of head.split(/\r?\n/)) {
    if (!rawLine.trim()) continue
    const indented = /^\s+/.test(rawLine)
    const line = rawLine.trim()
    const sep = line.indexOf(':')
    if (sep < 0) return { ok: false, error: `cannot parse this frontmatter line: ${line}` }
    const key = line.slice(0, sep).trim()
    let value = line.slice(sep + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value)
      } catch {
        // 保留原样
      }
    }
    if (!value && !indented) {
      currentMap = {}
      data[key] = currentMap
      continue
    }
    if (indented && currentMap) {
      currentMap[key] = value
      continue
    }
    currentMap = null
    data[key] = value
  }
  return { ok: true, data, body }
}

/** SKILL.md 文本 → 内部技能。优先读机器可读段，读不到就退化成"照说明做"的手工技能。 */
export function importSkillMarkdown(text, { id, now = new Date() } = {}) {
  const parsed = parseFrontmatter(text)
  if (!parsed.ok) return { ok: false, error: parsed.error }
  const { data, body } = parsed

  const name = String(data.name ?? '').trim()
  const description = String(data.description ?? '').trim()
  if (!name) return { ok: false, error: 'frontmatter is missing name' }
  if (!description) return { ok: false, error: 'frontmatter is missing description' }

  const warnings = []
  const block = /```json\s*\n([\s\S]*?)\n```/.exec(body)
  let skill = null
  if (block) {
    try {
      const machine = JSON.parse(block[1])
      if (machine && Array.isArray(machine.steps)) {
        skill = {
          schemaVersion: 1,
          id: machine.id || id || `skill_${now.toISOString().slice(0, 10).replace(/-/g, '')}_01`,
          title: machine.title || description.slice(0, 60),
          version: Number(machine.version) || 1,
          origin: machine.origin ?? { kind: 'manual', createdAt: now.toISOString(), author: 'imported' },
          params: Array.isArray(machine.params) ? machine.params : [],
          steps: machine.steps,
          health: machine.health ?? { runs: 0, ok: 0, fail: 0, failsInRow: 0, lastRunAt: null, lastFailReason: null, status: 'untested' },
          incomplete: machine.incomplete ?? { stepsWithoutChecks: 0, fragileSteps: 0 },
        }
      }
    } catch (error) {
      warnings.push(`machine-readable block failed to parse (${error instanceof Error ? error.message : String(error)}); falling back to a manual skill`)
    }
  }

  if (!skill) {
    // 别人的 SKILL.md：保留成"照说明执行"的单步技能，不装作我们知道细节
    const meta = data.metadata && typeof data.metadata === 'object' ? data.metadata : {}
    skill = {
      schemaVersion: 1,
      id: meta['handeye.id'] || id || `skill_${now.toISOString().slice(0, 10).replace(/-/g, '')}_01`,
      title: description.split(/[。；;]/)[0].slice(0, 60) || name,
      version: 1,
      origin: { kind: 'manual', createdAt: now.toISOString(), author: 'imported' },
      params: [],
      steps: [
        {
          id: 's1',
          intent: `Follow the SKILL.md instructions: ${name}`,
          tool: 'desk_windows',
          args: {},
          anchor: null,
          expect: null,
          onFail: 'ask',
        },
      ],
      health: { runs: 0, ok: 0, fail: 0, failsInRow: 0, lastRunAt: null, lastFailReason: null, status: 'untested' },
      incomplete: { stepsWithoutChecks: 1, fragileSteps: 0 },
    }
    warnings.push('this SKILL.md has no machine-readable block: converted to a single manual step with no checks')
  }

  return { ok: true, skill, warnings, name, description }
}
