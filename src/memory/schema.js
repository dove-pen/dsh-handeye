// Hand-written validators. The runtime stays dependency-free on purpose, so
// this module replaces a schema library with small, testable functions.
//
// Every validator returns { ok, errors } where errors is [{ path, message }].
// Unknown fields are rejected: silently accepted config is a source of drift.

export const SCHEMA_VERSION = 1

export const CAPABILITY_OPS = new Set([
  'open_url',
  'focus_window',
  'wait_text',
  'click_text',
  'type_text',
  'press_key',
  'read_text',
  'assert_text',
  'screenshot',
  'scroll_to_text',
])

export const CAPABILITY_RISKS = ['read', 'write', 'destructive']
export const CAPABILITY_STATUSES = ['draft', 'enabled', 'disabled']
export const CARD_ORIGINS = ['builtin', 'user', 'imported']
export const CARD_DELIVERIES = ['start', 'interject', 'both']
export const CARD_AUTONOMIES = ['readonly', 'supervised', 'full']
export const PARAM_TYPES = ['string', 'number', 'boolean', 'url', 'enum']

const SLUG_RE = /^[a-z][a-z0-9_]{2,40}$/
const URL_RE = /^https?:\/\/[^\s]+$/i

export function isSlug(value) {
  return typeof value === 'string' && SLUG_RE.test(value)
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isString(value, min, max) {
  return typeof value === 'string' && value.length >= min && value.length <= max
}

function isStringArray(value, maxItems, maxChars) {
  return (
    Array.isArray(value) &&
    value.length <= maxItems &&
    value.every((item) => typeof item === 'string' && item.length <= maxChars)
  )
}

function isPositiveInt(value) {
  return Number.isInteger(value) && value > 0
}

// ---------------------------------------------------------------- params

export function validateParamSchema(schema, path = 'params') {
  const errors = []
  const add = (p, message) => errors.push({ path: p, message })

  if (!isPlainObject(schema)) {
    add(path, 'must be an object')
    return { ok: false, errors }
  }
  for (const [key, spec] of Object.entries(schema)) {
    const at = `${path}.${key}`
    if (!isSlug(key)) {
      add(at, 'key must match ^[a-z][a-z0-9_]{2,40}$')
      continue
    }
    if (!isPlainObject(spec)) {
      add(at, 'must be an object')
      continue
    }
    if (!PARAM_TYPES.includes(spec.type)) {
      add(`${at}.type`, `must be one of: ${PARAM_TYPES.join(', ')}`)
      continue
    }
    if (spec.required !== undefined && typeof spec.required !== 'boolean') {
      add(`${at}.required`, 'must be a boolean')
    }
    if (spec.description !== undefined && !isString(spec.description, 0, 200)) {
      add(`${at}.description`, 'must be a string of at most 200 chars')
    }
    if (spec.type === 'enum') {
      if (!Array.isArray(spec.values) || spec.values.length === 0 || spec.values.length > 50) {
        add(`${at}.values`, 'enum requires 1-50 values')
      } else if (!spec.values.every((v) => typeof v === 'string')) {
        add(`${at}.values`, 'enum values must be strings')
      }
    }
    if (spec.default !== undefined) {
      const check = checkParamValue(spec, spec.default)
      if (!check.ok) add(`${at}.default`, check.message)
    }
  }
  return { ok: errors.length === 0, errors }
}

function checkParamValue(spec, value) {
  switch (spec.type) {
    case 'string':
      return typeof value === 'string'
        ? { ok: true }
        : { ok: false, message: 'must be a string' }
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? { ok: true }
        : { ok: false, message: 'must be a finite number' }
    case 'boolean':
      return typeof value === 'boolean'
        ? { ok: true }
        : { ok: false, message: 'must be a boolean' }
    case 'url':
      return typeof value === 'string' && URL_RE.test(value)
        ? { ok: true }
        : { ok: false, message: 'must be an http(s) URL' }
    case 'enum':
      return spec.values.includes(value)
        ? { ok: true }
        : { ok: false, message: `must be one of: ${spec.values.join(', ')}` }
    default:
      return { ok: false, message: 'unknown param type' }
  }
}

/** Apply defaults and reject unknown/invalid values. */
export function applyParams(schema, values = {}) {
  const out = {}
  const errors = []
  const add = (path, message) => errors.push({ path, message })

  if (!isPlainObject(values)) {
    return { ok: false, errors: [{ path: '', message: 'params must be an object' }] }
  }
  for (const key of Object.keys(values)) {
    if (!Object.prototype.hasOwnProperty.call(schema, key)) {
      add(key, 'unknown parameter')
    }
  }
  for (const [key, spec] of Object.entries(schema)) {
    if (Object.prototype.hasOwnProperty.call(values, key) && values[key] !== undefined) {
      const check = checkParamValue(spec, values[key])
      if (!check.ok) add(key, check.message)
      else out[key] = values[key]
      continue
    }
    if (spec.default !== undefined) {
      out[key] = spec.default
      continue
    }
    if (spec.required === true) add(key, 'required parameter is missing')
  }
  return { ok: errors.length === 0, values: out, errors }
}

// ---------------------------------------------------------------- capability

function validatePreconditions(list, add) {
  if (list === undefined) return
  if (!Array.isArray(list) || list.length > 10) {
    add('preconditions', 'must be an array of at most 10 checks')
    return
  }
  list.forEach((item, i) => {
    if (!isPlainObject(item) || typeof item.check !== 'string' || !item.check) {
      add(`preconditions[${i}]`, 'must be an object with a non-empty "check"')
    }
  })
}

function validateSteps(steps, add) {
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 40) {
    add('steps', 'must contain 1-40 steps')
    return
  }
  steps.forEach((step, i) => {
    const at = `steps[${i}]`
    if (!isPlainObject(step)) {
      add(at, 'must be an object')
      return
    }
    if (!CAPABILITY_OPS.has(step.op)) {
      add(`${at}.op`, `must be one of: ${[...CAPABILITY_OPS].join(', ')}`)
      return
    }
    switch (step.op) {
      case 'open_url':
        if (typeof step.url !== 'string' || !(URL_RE.test(step.url) || /^\$\{[a-zA-Z0-9_]+\}$/.test(step.url))) {
          add(`${at}.url`, 'must be an http(s) URL or a ${param} placeholder')
        }
        break
      case 'focus_window':
        if (!isString(step.title, 1, 200)) add(`${at}.title`, 'must be a non-empty string')
        break
      case 'wait_text':
      case 'click_text':
      case 'assert_text':
        if (!isString(step.text, 1, 500)) add(`${at}.text`, 'must be a non-empty string')
        break
      case 'type_text':
        if (typeof step.text !== 'string' || step.text.length > 2000) add(`${at}.text`, 'must be a string of at most 2000 chars')
        break
      case 'press_key':
        if (!isString(step.key, 1, 80)) add(`${at}.key`, 'must be a non-empty string')
        break
      case 'read_text':
        if (step.pattern !== undefined && !isString(step.pattern, 1, 500)) add(`${at}.pattern`, 'must be a non-empty string')
        if (step.text !== undefined && !isString(step.text, 1, 500)) add(`${at}.text`, 'must be a non-empty string')
        break
      case 'scroll_to_text':
        if (!isString(step.text, 1, 500)) add(`${at}.text`, 'must be a non-empty string')
        break
      case 'screenshot':
        if (step.path !== undefined && !isString(step.path, 1, 500)) add(`${at}.path`, 'must be a string')
        break
      default:
        break
    }
    if (step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 100 || step.timeoutMs > 120000)) {
      add(`${at}.timeoutMs`, 'must be an integer between 100 and 120000')
    }
  })
}

function validatePostconditions(list, add) {
  if (list === undefined) return
  if (!Array.isArray(list) || list.length > 10) {
    add('postconditions', 'must be an array of at most 10 assertions')
    return
  }
  list.forEach((item, i) => {
    if (!isPlainObject(item) || typeof item.assert !== 'string' || !item.assert) {
      add(`postconditions[${i}]`, 'must be an object with a non-empty "assert"')
    }
  })
}

export function validateCapability(cap) {
  const errors = []
  const add = (path, message) => errors.push({ path, message })

  if (!isPlainObject(cap)) return { ok: false, errors: [{ path: '', message: 'must be an object' }] }

  if (cap.schemaVersion !== SCHEMA_VERSION) add('schemaVersion', `must be ${SCHEMA_VERSION}`)
  if (!isSlug(cap.name)) add('name', 'must match ^[a-z][a-z0-9_]{2,40}$')
  if (!isString(cap.title, 1, 80)) add('title', 'must be 1-80 chars')
  if (cap.description !== undefined && !isString(cap.description, 0, 500)) add('description', 'must be at most 500 chars')
  if (!CAPABILITY_RISKS.includes(cap.risk)) add('risk', `must be one of: ${CAPABILITY_RISKS.join(', ')}`)
  if (!CAPABILITY_STATUSES.includes(cap.status)) add('status', `must be one of: ${CAPABILITY_STATUSES.join(', ')}`)
  if (cap.fromEpisode !== undefined && typeof cap.fromEpisode !== 'string') add('fromEpisode', 'must be a string')

  const paramsResult = validateParamSchema(cap.params ?? {})
  if (!paramsResult.ok) errors.push(...paramsResult.errors)

  validatePreconditions(cap.preconditions, add)
  validateSteps(cap.steps, add)
  validatePostconditions(cap.postconditions, add)

  if (cap.outputs !== undefined) {
    if (!isStringArray(cap.outputs, 10, 40)) add('outputs', 'must be an array of at most 10 strings')
  }

  return { ok: errors.length === 0, errors }
}

// ---------------------------------------------------------------- card

export function validateCard(card) {
  const errors = []
  const add = (path, message) => errors.push({ path, message })

  if (!isPlainObject(card)) return { ok: false, errors: [{ path: '', message: 'must be an object' }] }

  if (card.schemaVersion !== SCHEMA_VERSION) add('schemaVersion', `must be ${SCHEMA_VERSION}`)
  if (!isSlug(card.id)) add('id', 'must match ^[a-z][a-z0-9_]{2,40}$')
  if (!isString(card.title, 1, 80)) add('title', 'must be 1-80 chars')
  if (!CARD_ORIGINS.includes(card.origin)) add('origin', `must be one of: ${CARD_ORIGINS.join(', ')}`)
  if (!isPositiveInt(card.version)) add('version', 'must be a positive integer')
  if (!CARD_DELIVERIES.includes(card.delivery)) add('delivery', `must be one of: ${CARD_DELIVERIES.join(', ')}`)
  if (!CARD_AUTONOMIES.includes(card.autonomy)) add('autonomy', `must be one of: ${CARD_AUTONOMIES.join(', ')}`)
  if (!isString(card.goal, 1, 1000)) add('goal', 'must be 1-1000 chars')
  if (!isString(card.success, 1, 500)) add('success', 'must be 1-500 chars')
  if (card.onFailure !== undefined && !isString(card.onFailure, 0, 500)) add('onFailure', 'must be at most 500 chars')
  if (card.enabled !== undefined && typeof card.enabled !== 'boolean') add('enabled', 'must be a boolean')

  if (!Array.isArray(card.constraints) || card.constraints.length > 20) {
    add('constraints', 'must be an array of at most 20 strings')
  } else {
    card.constraints.forEach((c, i) => {
      if (!isString(c, 0, 300)) add(`constraints[${i}]`, 'must be at most 300 chars')
    })
  }

  if (card.allowedTools !== undefined && !isStringArray(card.allowedTools, 20, 80)) {
    add('allowedTools', 'must be an array of at most 20 tool patterns')
  }
  if (card.path !== undefined) {
    if (!Array.isArray(card.path) || card.path.length < 1 || card.path.length > 12) {
      add('path', 'must be an array of 1-12 ordered steps')
    } else {
      card.path.forEach((step, i) => {
        if (!isString(step, 1, 200)) add(`path[${i}]`, 'must be 1-200 chars')
      })
    }
  }
  if (card.capabilities !== undefined) {
    if (!Array.isArray(card.capabilities) || !card.capabilities.every(isSlug)) {
      add('capabilities', 'must be an array of capability slugs')
    }
  }
  if (card.directCapability !== undefined && !isSlug(card.directCapability)) {
    add('directCapability', 'must be a capability slug')
  }

  const paramsResult = validateParamSchema(card.params ?? {})
  if (!paramsResult.ok) errors.push(...paramsResult.errors)

  return { ok: errors.length === 0, errors }
}
