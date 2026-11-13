// 一个够用的 JSON Schema 子集校验器：零依赖。
//
// 支持：type（含数组）、required、properties、additionalProperties、items、
//       enum、const、minItems、maxItems、minimum、minLength、oneOf。
// 不支持 $ref / allOf / patternProperties —— 我们的 schema 用不到，用到时再加。

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  if (Number.isInteger(value)) return 'integer'
  const t = typeof value
  if (t === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return t
}

function matchesType(value, type) {
  const actual = typeOf(value)
  if (type === 'number') return actual === 'number' || actual === 'integer'
  if (type === 'integer') return actual === 'integer'
  return actual === type
}

export function validate(schema, value, path = '') {
  const errors = []
  const at = (p) => (path ? `${path}.${p}` : String(p))
  const push = (p, message) => errors.push({ path: p || path || '', message })

  if (!schema || typeof schema !== 'object') return errors

  if (schema.const !== undefined && value !== schema.const) {
    push(path, `must equal ${JSON.stringify(schema.const)}`)
    return errors
  }

  if (schema.enum && !schema.enum.some((v) => v === value)) {
    push(path, `must be one of: ${schema.enum.join(', ')}`)
    return errors
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type]
    if (!types.some((t) => matchesType(value, t))) {
      push(path, `must be ${types.join(' or ')}`)
      return errors
    }
  }

  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter((s) => validate(s, value, path).length === 0)
    if (matches.length === 0) push(path, 'must match one of the allowed shapes')
    // 不 return：同一层的 required / additionalProperties 还要继续查
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      push(path, `must be at least ${schema.minLength} chars`)
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) push(path, `must be >= ${schema.minimum}`)
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      push(path, `must contain at least ${schema.minItems} item(s)`)
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      push(path, `must contain at most ${schema.maxItems} item(s)`)
    }
    if (schema.items) {
      value.forEach((item, index) => errors.push(...validate(schema.items, item, `${path}[${index}]`)))
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const key of schema.required ?? []) {
      if (!(key in value)) push(at(key), 'is required')
    }
    const props = schema.properties ?? {}
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) errors.push(...validate(sub, value[key], at(key)))
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) push(at(key), 'is not allowed here')
      }
    }
  }

  return errors
}

/** 校验失败时给一句人能读的话。 */
export function summarize(errors, limit = 5) {
  if (!errors.length) return ''
  const lines = errors.slice(0, limit).map((e) => (e.path ? `${e.path} ${e.message}` : e.message))
  if (errors.length > limit) lines.push(`… ${errors.length - limit} more`)
  return lines.join('；')
}
