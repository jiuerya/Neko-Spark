/**
 * focused Hub API contract test。
 * 只启动一个临时 Hub，覆盖认证前置、配对、输入校验、空文件上传和回收站保护，
 * 不导入真实媒体，也不运行完整 UI smoke。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

const projectRoot = resolve(import.meta.dirname, '..')
const dataDir = mkdtempSync(join(tmpdir(), 'neko-api-contract-'))
const hubPort = Number(process.env.GALLERY_MIRROR_API_TEST_PORT) || 8899
const cdpPort = Number(process.env.GALLERY_MIRROR_API_TEST_CDP_PORT) || 9234
const base = `https://127.0.0.1:${hubPort}/api/v1`
const electron = join(projectRoot, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const child = spawn(electron, ['.', `--remote-debugging-port=${cdpPort}`], {
  cwd: projectRoot,
  env: { ...process.env, GALLERY_MIRROR_DATA: dataDir, GALLERY_MIRROR_PORT: String(hubPort) },
  stdio: 'ignore'
})

let socket
let passed = true

function check(name, ok, detail = '') {
  passed &&= ok
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` (${detail})` : ''}`)
}

async function waitFor(fn, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await fn().catch(() => null)
    if (value) return value
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 150))
  }
  throw new Error('focused API test timeout')
}

function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      // 进程已经退出。
    }
  }
}

async function removeScratchDir(dir) {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 150 })
      return
    } catch {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250))
    }
  }
  // 临时目录清理失败不应把已经通过的 API 检查变成业务失败；CI runner 会回收临时目录。
  console.warn(`[WARN] 无法立即清理 focused API 临时目录：${dataDir}`)
}

async function request(path, init) {
  return fetch(`${base}${path}`, init)
}

try {
  await waitFor(async () => (await request('/health')).ok)
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`)
    const pages = await response.json()
    return pages.find((page) => page.type === 'page')
  })

  socket = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolvePromise, reject) => {
    socket.onopen = resolvePromise
    socket.onerror = reject
  })

  let messageId = 0
  const pending = new Map()
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data)
    const callback = pending.get(message.id)
    if (!callback) return
    pending.delete(message.id)
    callback(message)
  }
  const evaluate = (expression) =>
    new Promise((resolvePromise, reject) => {
      const id = ++messageId
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error(`CDP evaluate timeout: ${expression.slice(0, 80)}`))
      }, 20000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolvePromise(message.result?.result?.value)
      })
      socket.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, returnByValue: true, awaitPromise: true }
      }))
    })

  const status = JSON.parse(await evaluate('window.gm.getStatus().then((value) => JSON.stringify(value))'))
  const device = { deviceId: 'api-contract-device', name: '接口测试设备', model: 'ContractTest' }
  const wrongVersion = await request('/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 999, code: status.hub.pairingCode, device })
  })
  check('不支持的协议版本返回 426', wrongVersion.status === 426, String(wrongVersion.status))

  const pair = await request('/pair', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, code: status.hub.pairingCode, device })
  })
  const pairResult = await pair.json()
  check('配对成功登记设备', pair.status === 200 && pairResult.deviceRegistered === true)
  const devices = await (await request('/devices')).json()
  check('配对设备立即出现在设备列表', devices.devices.some((item) => item.id === device.deviceId))

  const invalidIds = await request('/media/trash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [1, 'bad'] })
  })
  check('批量 ID 遇到非法元素时整体拒绝', invalidIds.status === 400, String(invalidIds.status))

  const invalidFile = await request('/file/not-a-number')
  check('媒体 ID 严格校验', invalidFile.status === 400, String(invalidFile.status))

  const emptySha = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
  const emptyUpload = await request(`/blob/${emptySha}`, {
    method: 'PUT',
    headers: { 'Content-Length': '0' },
    body: ''
  })
  const emptyResult = await emptyUpload.json()
  check('0 字节文件可以完成上传', emptyUpload.status === 200 && emptyResult.complete === true)

  const item = {
    sha256: emptySha,
    displayName: 'empty.bin',
    relativePath: '',
    bucketId: '/',
    bucketName: '',
    mimeType: 'application/octet-stream',
    size: 0
  }
  const manifest = await request('/manifest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, device, items: [item] })
  })
  check('manifest 接受协议 v1', manifest.status === 200, String(manifest.status))

  const commit = await request('/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 1, device, items: [item] })
  })
  check('commit 接受已校验的空文件', commit.status === 200, String(commit.status))

  const media = (await (await request(`/media?deviceId=${encodeURIComponent(device.deviceId)}`)).json()).media
  const active = media.find((entry) => entry.displayName === item.displayName)
  check('空文件按真实 blob 大小入库', Boolean(active) && active.size === 0)
  if (active) {
    const purge = await request('/media/purge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: [active.id] })
    })
    const purgeResult = await purge.json()
    check('purge 不允许直接删除正常媒体', purge.status === 200 && purgeResult.count === 0)
  }
} catch (error) {
  passed = false
  console.error(`[FAIL] focused API test: ${error instanceof Error ? error.message : String(error)}`)
} finally {
  socket?.close()
  killTree(child.pid)
  await removeScratchDir(dataDir)
}

process.exit(passed ? 0 : 1)
