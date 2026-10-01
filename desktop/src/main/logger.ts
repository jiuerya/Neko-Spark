import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'

const LOG_DIR_NAME = 'logs'
const LOG_FILE_NAME = 'startup.log'
const MAX_LOG_BYTES = 2 * 1024 * 1024

let logFile = ''

function redact(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted-pem]')
    .replace(/(authorization|token|password|secret|private.?key|cookie)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/(?:[A-Za-z]:\\|\\\\)[^\r\n"']+/g, '[local-path]')
}

function errorText(error: unknown): string {
  if (error instanceof Error) return redact(error.stack || error.message)
  return redact(String(error))
}

function safeFields(fields: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!fields) return {}
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (/token|secret|password|private.?key|authorization|cookie|cert(ificate)?/i.test(key)) {
      result[key] = '[redacted]'
    } else if (value instanceof Error) {
      result[key] = errorText(value)
    } else if (typeof value === 'string') {
      result[key] = redact(value)
    } else {
      result[key] = value
    }
  }
  return result
}

/** 用路径尾部和短指纹辅助定位，不把完整本机路径写进诊断日志。 */
export function summarizePath(value: string): Record<string, string> {
  const normalized = value.replaceAll('\\', '/')
  const parts = normalized.split('/').filter(Boolean)
  const tail = parts.slice(-2).join('/') || parts.at(-1) || '[empty]'
  return {
    tail,
    fingerprint: createHash('sha256').update(normalized).digest('hex').slice(0, 12)
  }
}

function rotateIfNeeded(): void {
  try {
    if (logFile && existsSync(logFile) && statSync(logFile).size > MAX_LOG_BYTES) {
      renameSync(logFile, `${logFile}.old`)
    }
  } catch {
    // 日志轮转失败不应影响主程序启动。
  }
}

export function initLogger(dataDir: string): string | undefined {
  const candidates = [
    join(dataDir, 'runtime', LOG_DIR_NAME),
    process.env.APPDATA ? join(process.env.APPDATA, 'Neko_Spark', LOG_DIR_NAME) : undefined,
    process.env.XDG_STATE_HOME ? join(process.env.XDG_STATE_HOME, 'Neko_Spark', LOG_DIR_NAME) : undefined
  ].filter((value): value is string => Boolean(value))

  for (const logDir of candidates) {
    try {
      mkdirSync(logDir, { recursive: true })
      logFile = join(logDir, LOG_FILE_NAME)
      rotateIfNeeded()
      return logFile
    } catch {
      // 相册仓库可能位于只读磁盘，继续尝试用户级诊断目录。
    }
  }
  logFile = ''
  return undefined
}

export function diagnosticLogPath(): string {
  return logFile
}

export function log(level: 'info' | 'warn' | 'error', event: string, fields?: Record<string, unknown>): void {
  const record = {
    time: new Date().toISOString(),
    level,
    event,
    ...safeFields(fields)
  }
  const line = `${JSON.stringify(record)}\n`
  try {
    if (logFile) appendFileSync(logFile, line, 'utf8')
  } catch {
    // 诊断日志不可写时继续使用 console，不能反过来阻断应用。
  }
}

export function logError(event: string, error: unknown, fields?: Record<string, unknown>): void {
  log('error', event, { ...fields, error: errorText(error) })
}
