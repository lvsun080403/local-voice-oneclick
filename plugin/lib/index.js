// dsh-voice-bridge —— 把本机的 Qwen3-ASR / Qwen3-TTS 桥进 DSH
//
// 两个语音服务都是 Gradio 应用，不是 OpenAI 兼容接口，所以没法当“模型提供商”
// 挂进设置页。这里的做法是在 DSH 宿主里起一层很薄的 HTTP 代理：
//   浏览器（插件面板） → DSH 宿主 /voice-bridge/api/* → Gradio /gradio_api/*
// 好处是不用处理浏览器跨域，端口也只在本机回环上暴露。
//
// 路由：
//   GET  /status      两个模型的状态（在跑没、开关、闲置分钟）
//   GET  /config      完整配置
//   POST /config      改配置（深一层合并）
//   POST /model       单模型开关 / 设闲置时间 { id: 'asr'|'tts', enabled?, idleMinutes? }
//   POST /transcribe  base64 音频 → 文本
//   POST /speak       文本(+参考音频) → wav 地址
// 另外每 20 秒跑一次闲置检查：开关打开且超过设定分钟没请求，就停掉那个服务。
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'

export const name = 'voice-bridge'
export const inject = []

const PREFIX = '/voice-bridge/api'
const HOME = process.env.USERPROFILE || process.env.HOME || '.'
const CONFIG_DIR = path.join(HOME, '.dsh', 'voice-bridge')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

const LANGS = ['Auto', 'Chinese', 'English', 'Japanese', 'Korean', 'Cantonese']

const DEFAULTS = {
  asr: {
    port: 8010,
    model: 'Qwen3-ASR-1.7B',
    dir: 'D:\\1\\Qwen3-ASR-1.7B',
    enabled: true,
    idleMinutes: 10
  },
  tts: {
    port: 8011,
    model: 'Qwen3-TTS-12Hz-1.7B-Base',
    dir: 'D:\\1\\Qwen3-TTS-1.7B',
    enabled: true,
    idleMinutes: 10
  },
  lang: 'Auto',
  xvec: false
}

// 合并时对 asr/tts 这类子对象再深一层，避免只改一项就把整段覆盖掉
function mergeConfig(base, patch) {
  const out = { ...base }
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = { ...base[k], ...v }
    } else {
      out[k] = v
    }
  }
  return out
}

async function readConfig() {
  try {
    // 记事本存过的 JSON 可能带 BOM，先剥掉再 parse
    const raw = (await fs.readFile(CONFIG_FILE, 'utf8')).replace(/^\uFEFF/, '')
    return mergeConfig(DEFAULTS, JSON.parse(raw))
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS))
  }
}

async function writeConfig(cfg) {
  await fs.mkdir(CONFIG_DIR, { recursive: true })
  await fs.writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), 'utf8')
  return cfg
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function probe(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) })
    return r.ok
  } catch {
    return false
  }
}

// netstat 找监听该端口的 PID
function portPid(port) {
  return new Promise((resolve) => {
    const ps = spawn('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true })
    let out = ''
    ps.stdout.on('data', (d) => { out += d.toString() })
    ps.on('error', () => resolve(null))
    ps.on('close', () => {
      const line = out.split(/\r?\n/).find((l) => l.includes(`:${port} `) && /LISTENING/i.test(l))
      if (!line) return resolve(null)
      const parts = line.trim().split(/\s+/)
      resolve(parts[parts.length - 1] || null)
    })
  })
}

async function stopPort(port) {
  const pid = await portPid(port)
  if (!pid) return false
  await new Promise((resolve) => {
    const ps = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true })
    ps.on('error', resolve)
    ps.on('close', resolve)
  })
  for (let i = 0; i < 10; i += 1) {
    if (!(await probe(port))) return true
    await sleep(400)
  }
  return true
}

// 拉起服务：调部署包里的 serve.ps1（后台模式），再轮询端口
async function startService(kind, cfg) {
  const spec = cfg[kind]
  const script = path.join(spec.dir, 'scripts', 'serve.ps1')
  try {
    await fs.access(script)
  } catch {
    throw new Error(`找不到 ${script}，先把 ${kind.toUpperCase()} 部署包放到这个目录`)
  }
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Background', '-NoBrowser']
  const ps = spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore', cwd: spec.dir })
  ps.on('error', () => {})
  for (let i = 0; i < 90; i += 1) {
    if (await probe(spec.port)) return true
    await sleep(1000)
  }
  throw new Error(`${kind.toUpperCase()} 在 90 秒内没起来，去 ${spec.dir}\\logs 看日志`)
}

// 闲置计时的基准：真正调用成功的时间
const lastUsed = { asr: Date.now(), tts: Date.now() }

// ---------- 部署另一个模型：选目录 + 启动它的 install ----------
const deployState = { child: null, dir: '', log: '', startedAt: 0 }

// 原生目录选择框：必须给一个隐藏的 owner 窗口，否则在无控制台进程里 ShowDialog 会立刻返回 Cancel
const PICK_SCRIPT = `Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$out = $args[0]
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.Width = 1
$owner.Height = 1
$owner.ShowInTaskbar = $false
$owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = '选择模型部署目录（里面要有 install.bat 或 scripts\\install.ps1）'
$dlg.ShowNewFolderButton = $false
$res = $dlg.ShowDialog($owner)
if ($res -eq [System.Windows.Forms.DialogResult]::OK) {
  [IO.File]::WriteAllText($out, $dlg.SelectedPath)
} else {
  [IO.File]::WriteAllText($out, '__CANCELLED__')
}
$owner.Dispose()
`

async function pickFolder() {
  const tmpdir = path.join(CONFIG_DIR, 'tmp')
  await fs.mkdir(tmpdir, { recursive: true })
  const stamp = Date.now()
  const psFile = path.join(tmpdir, `pick-${stamp}.ps1`)
  const outFile = path.join(tmpdir, `pick-${stamp}.txt`)
  // 必须带 BOM，否则 PS 5.1 按 ANSI 读中文注释会报语法错
  await fs.writeFile(psFile, '\uFEFF' + PICK_SCRIPT, 'utf8')
  const ps = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-File', psFile, outFile], {
    windowsHide: true,
    stdio: 'ignore'
  })
  ps.on('error', () => {})
  for (let i = 0; i < 600; i += 1) {
    try {
      const raw = await fs.readFile(outFile, 'utf8')
      const val = raw.replace(/^\uFEFF/, '').trim()
      if (val === '__CANCELLED__') return { cancelled: true }
      if (val) return { dir: val }
    } catch {
      // 还没写出来
    }
    await sleep(200)
  }
  return { cancelled: true }
}

// 目录里找安装入口：优先 install.bat，其次 scripts\install.ps1
async function deployEntry(dir) {
  const bat = path.join(dir, 'install.bat')
  const ps1 = path.join(dir, 'scripts', 'install.ps1')
  for (const [p, kind] of [[bat, 'bat'], [ps1, 'ps1']]) {
    try {
      await fs.access(p)
      return { path: p, kind }
    } catch {
      // 继续找下一个
    }
  }
  return null
}

async function startDeploy(dir) {
  const entry = await deployEntry(dir)
  if (!entry) throw new Error('这个目录里没有 install.bat 或 scripts\\install.ps1，不像部署包')
  if (deployState.child && deployState.child.exitCode === null) throw new Error('已经有一个部署在跑了')

  const log = path.join(dir, `deploy-${Date.now()}.log`)
  const fd = (await import('node:fs')).openSync(log, 'w')
  const cmd = entry.kind === 'bat'
    ? ['cmd.exe', ['/c', entry.path]]
    : ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', entry.path]]
  const child = spawn(cmd[0], cmd[1], {
    windowsHide: true,
    cwd: dir,
    stdio: ['ignore', fd, fd]
  })
  child.on('error', () => {})
  deployState.child = child
  deployState.dir = dir
  deployState.log = log
  deployState.startedAt = Date.now()
  return { dir, log, entry: entry.path }
}

async function deployStatus() {
  const running = !!(deployState.child && deployState.child.exitCode === null)
  let tail = ''
  if (deployState.log) {
    try {
      const raw = await fs.readFile(deployState.log, 'utf8')
      const lines = raw.replace(/\r/g, '').split('\n').filter((l) => l.trim())
      tail = lines.slice(-3).join('\n')
    } catch {
      tail = ''
    }
  }
  return {
    dir: deployState.dir,
    running,
    log: deployState.log,
    tail,
    elapsedSec: deployState.startedAt ? Math.round((Date.now() - deployState.startedAt) / 1000) : 0
  }
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 64 * 1024 * 1024) req.destroy() })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

async function gradioUpload(port, buf, filename, mime) {
  const form = new FormData()
  form.append('files', new Blob([buf], { type: mime || 'application/octet-stream' }), filename || 'upload.bin')
  const r = await fetch(`http://127.0.0.1:${port}/gradio_api/upload`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120000)
  })
  if (!r.ok) throw new Error(`上传到 :${port} 失败（HTTP ${r.status}）`)
  const arr = await r.json()
  const p = Array.isArray(arr) ? arr[0] : (arr && arr.files ? arr.files[0] : null)
  if (!p) throw new Error('上传返回里没有文件路径')
  return String(p)
}

// Gradio 的 /call 是 SSE：POST 拿 event_id，再 GET 那一串事件等 complete
async function gradioCall(port, fn, data, timeoutMs) {
  const base = `http://127.0.0.1:${port}/gradio_api/call/${fn}`
  const post = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ data }),
    signal: AbortSignal.timeout(30000)
  })
  if (!post.ok) {
    const text = await post.text().catch(() => '')
    throw new Error(`调用 ${fn} 失败（HTTP ${post.status}）${text ? '：' + text.slice(0, 300) : ''}`)
  }
  const payload = await post.json()
  const id = payload && payload.event_id
  if (!id) throw new Error('没有拿到 event_id')

  const r = await fetch(`${base}/${id}`, { signal: AbortSignal.timeout(timeoutMs || 300000) })
  if (!r.ok || !r.body) throw new Error(`订阅 ${fn} 结果失败（HTTP ${r.status}）`)

  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  let event = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += dec.decode(value, { stream: true })
    const lines = buf.split(/\r?\n/)
    buf = lines.pop() || ''
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim()
      else if (line.startsWith('data:')) {
        const dataLine = line.slice(5).trim()
        if (event === 'complete') return JSON.parse(dataLine)
        if (event === 'error') throw new Error(dataLine.slice(0, 500))
      }
    }
  }
  throw new Error(`${fn} 没有返回 complete 事件`)
}

const b64ToBuffer = (b64) => Buffer.from(String(b64 || ''), 'base64')

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1')
  const route = decodeURIComponent(url.pathname).slice(PREFIX.length).replace(/\/+$/, '') || '/'
  const cfg = await readConfig()

  if (req.method === 'GET' && route === '/status') {
    const [asrOk, ttsOk] = await Promise.all([probe(cfg.asr.port), probe(cfg.tts.port)])
    const now = Date.now()
    return sendJson(res, 200, {
      ok: true,
      lang: cfg.lang,
      langs: LANGS,
      asr: {
        port: cfg.asr.port,
        ok: asrOk,
        dir: cfg.asr.dir,
        model: cfg.asr.model,
        enabled: !!cfg.asr.enabled,
        idleMinutes: cfg.asr.idleMinutes,
        idleSec: Math.round((now - lastUsed.asr) / 1000)
      },
      tts: {
        port: cfg.tts.port,
        ok: ttsOk,
        dir: cfg.tts.dir,
        model: cfg.tts.model,
        enabled: !!cfg.tts.enabled,
        idleMinutes: cfg.tts.idleMinutes,
        idleSec: Math.round((now - lastUsed.tts) / 1000)
      }
    })
  }

  if (req.method === 'GET' && route === '/config') return sendJson(res, 200, { ok: true, ...cfg })

  if (req.method === 'POST' && route === '/config') {
    const patch = JSON.parse((await readBody(req)) || '{}')
    const next = mergeConfig(cfg, patch)
    await writeConfig(next)
    return sendJson(res, 200, { ok: true, ...next })
  }

  // 单个模型：开关 + 闲置分钟
  if (req.method === 'POST' && route === '/model') {
    const body = JSON.parse((await readBody(req)) || '{}')
    const kind = body.id === 'tts' ? 'tts' : 'asr'
    const next = JSON.parse(JSON.stringify(cfg))
    if (typeof body.idleMinutes === 'number' && body.idleMinutes >= 0) {
      next[kind].idleMinutes = Math.round(body.idleMinutes)
    }
    if (typeof body.enabled === 'boolean') next[kind].enabled = body.enabled
    await writeConfig(next)

    if (typeof body.enabled === 'boolean') {
      if (body.enabled) {
        lastUsed[kind] = Date.now()
        if (!(await probe(next[kind].port))) {
          try {
            await startService(kind, next)
          } catch (e) {
            return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
          }
        }
      } else {
        await stopPort(next[kind].port)
      }
    }
    return sendJson(res, 200, { ok: true, ...next })
  }

  if (req.method === 'POST' && route === '/transcribe') {
    const body = JSON.parse((await readBody(req)) || '{}')
    if (!body.audio) return sendJson(res, 400, { ok: false, error: '缺少 audio（base64）' })
    const port = body.port || cfg.asr.port
    const lang = LANGS.includes(body.lang) ? body.lang : cfg.lang
    try {
      const ref = await gradioUpload(port, b64ToBuffer(body.audio), body.filename || 'audio.wav', body.mime)
      // /run 后面还挂着一个隐藏的 State，必须凑够 3 个入参
      const out = await gradioCall(port, 'run', [
        { path: ref, orig_name: body.filename || 'audio.wav', meta: { _type: 'gradio.FileData' } },
        lang,
        null
      ])
      lastUsed.asr = Date.now()
      const arr = out && out.data
      if (!Array.isArray(arr)) return sendJson(res, 502, { ok: false, error: '返回格式不认识：' + JSON.stringify(out).slice(0, 300) })
      return sendJson(res, 200, { ok: true, lang: String(arr[0] || lang), text: String(arr[1] || '') })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
  }

  if (req.method === 'POST' && route === '/speak') {
    const body = JSON.parse((await readBody(req)) || '{}')
    if (!body.text) return sendJson(res, 400, { ok: false, error: '缺少 text' })
    const port = body.port || cfg.tts.port
    const lang = LANGS.includes(body.lang) ? body.lang : cfg.lang
    try {
      let refData = null
      if (body.ref) {
        const p = await gradioUpload(port, b64ToBuffer(body.ref), body.refName || 'ref.wav', body.refMime)
        refData = { path: p, orig_name: body.refName || 'ref.wav', meta: { _type: 'gradio.FileData' } }
      }
      const out = await gradioCall(port, 'run_voice_clone', [refData, body.refText || '', !!body.xvec, body.text, lang], 600000)
      lastUsed.tts = Date.now()
      const arr = out && out.data
      if (!Array.isArray(arr)) return sendJson(res, 502, { ok: false, error: '返回格式不认识：' + JSON.stringify(out).slice(0, 300) })
      const audio = arr[0]
      const status = String(arr[1] || '')
      let audioUrl = ''
      if (audio && audio.url) {
        audioUrl = /^https?:/.test(audio.url) ? audio.url : `http://127.0.0.1:${port}${audio.url}`
      }
      return sendJson(res, 200, { ok: true, audioUrl, status })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
  }

  // ---------- 部署另一个模型 ----------
  if (req.method === 'POST' && route === '/deploy/pick') {
    try {
      const r = await pickFolder()
      if (r.cancelled) return sendJson(res, 200, { ok: true, cancelled: true })
      const entry = await deployEntry(r.dir)
      return sendJson(res, 200, {
        ok: true,
        dir: r.dir,
        entry: entry ? entry.path : null,
        ready: !!entry
      })
    } catch (e) {
      return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) })
    }
  }

  if (req.method === 'POST' && route === '/deploy/start') {
    try {
      const body = JSON.parse((await readBody(req)) || '{}')
      if (!body.dir) return sendJson(res, 400, { ok: false, error: '缺少 dir' })
      const r = await startDeploy(body.dir)
      return sendJson(res, 200, { ok: true, ...r })
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: String((e && e.message) || e) })
    }
  }

  if (req.method === 'GET' && route === '/deploy/status') {
    return sendJson(res, 200, { ok: true, ...(await deployStatus()) })
  }

  if (req.method === 'POST' && route === '/deploy/stop') {
    const child = deployState.child
    if (child && child.exitCode === null) {
      try { child.kill() } catch {}
    }
    return sendJson(res, 200, { ok: true })
  }

  return sendJson(res, 404, { ok: false, error: 'no such route: ' + route })
}

// 闲置自动关闭：开关打开 + 超过设定分钟没有请求 → 停掉该服务
async function idleTick() {
  try {
    const cfg = await readConfig()
    for (const kind of ['asr', 'tts']) {
      const spec = cfg[kind]
      if (!spec.enabled || !spec.idleMinutes) continue
      if (!(await probe(spec.port))) continue
      if (Date.now() - lastUsed[kind] > spec.idleMinutes * 60000) {
        await stopPort(spec.port)
        log(`idle: ${kind} 超过 ${spec.idleMinutes} 分钟没有请求，已停止 :${spec.port}`)
      }
    }
  } catch (e) {
    log('idleTick 出错: ' + String((e && e.message) || e))
  }
}

let log = () => {}
let timer = null

export function apply(ctx) {
  log = (m) => { try { ctx.logger?.info?.(m) } catch {} }

  timer = setInterval(idleTick, 20000)
  if (typeof timer.unref === 'function') timer.unref()
  ctx.effect(() => () => { if (timer) clearInterval(timer) }, 'voice-bridge idle timer')

  const mount = () => {
    const webServer = ctx.get('webServer')
    if (!webServer) return false
    ctx.effect(() => webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: (request, response) => {
        handle(request, response).catch((e) => {
          try { sendJson(response, 500, { ok: false, error: String((e && e.message) || e) }) } catch {}
        })
      }
    }), 'voice-bridge routes')
    return true
  }

  if (!mount()) {
    const t = setInterval(() => { if (mount()) clearInterval(t) }, 500)
    if (typeof t.unref === 'function') t.unref()
  }
}

// 离线测试用
export const __test = { handle, idleTick, readConfig, writeConfig, mergeConfig }
