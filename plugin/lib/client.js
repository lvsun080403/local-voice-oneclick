// 浏览器半边：输入框左侧（权限 / 计划模式右边）加一个「语音」小胶囊，
// 点开是玻璃质感浮层，里面有「转写」「朗读」两个页签，各自带开关与闲置自动关闭。
// 重活都在宿主半边做，这里只发 JSON、收 JSON。
window.__ModuleLoader__.load({
  id: 'dsh-voice-bridge',
  factory: (require) => {
    const { createElement: h, useState, useEffect, useRef } = require('react')

    // 浮层挂到 body：输入区那几层容器带 transform / overflow，
    // 在里面写 position:fixed 会被裁切、z-index 也被关在那一层。
    let createPortal = null
    try { createPortal = require('react-dom').createPortal || null } catch { createPortal = null }

    const API = '/voice-bridge/api'
    const STYLE_ID = 'dsh-voice-bridge-style'
    const PANEL_W = 460
    // 语音面板按「朗读页整页放得下」定高：文字框 + 参考音频 + 参考文本 + 语种 +
    // 声纹 + 按钮 + 播放器 + 合成状态框，全塞进 860 才不会截掉状态框。
    const PANEL_H = 780
    // 部署面板东西少，只给一半高，别一大块空玻璃杵在那儿。
    const DEPLOY_H = Math.round(PANEL_H / 2)

    const LANGS = [
      ['Auto', '自动识别'],
      ['Chinese', '中文'],
      ['English', '英语'],
      ['Japanese', '日语'],
      ['Korean', '韩语'],
      ['Cantonese', '粤语']
    ]
    const IDLE_CHOICES = [5, 10, 20, 30, 60]

    const STYLE_TEXT = `
.vb-chip {
  display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px;
  border-radius: 999px; cursor: pointer; white-space: nowrap;
  font: 12px/1 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  color: #dfe3ea; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  transition: background .15s ease, border-color .15s ease;
}
.vb-chip:hover { background: rgba(96,165,255,.16); border-color: rgba(96,165,255,.45); }
.vb-chip.is-open { background: rgba(96,165,255,.22); border-color: rgba(96,165,255,.55); }
.vb-dot { width: 7px; height: 7px; border-radius: 50%; background: #8e8e93; flex: 0 0 auto; }
.vb-dot.is-on { background: #2ef06f; box-shadow: 0 0 8px rgba(46,240,111,.6); }
.vb-dot.is-off { background: #ff453a; box-shadow: 0 0 8px rgba(255,69,58,.5); }
.vb-dot.is-wait { background: #ffd60a; }

.vb-panel {
  position: fixed; z-index: 2147483600;
  /* 高度由 panelStyle() 算好写进行内样式：这里只留一个兜底值。
     以前写死 82vh，窗口矮的时候会把 700px 的设定又压回去，等于白算 */
  width: 460px; height: 700px;
  display: flex; flex-direction: column;
  color: #e9ecf2; font: 13px/1.55 "Segoe UI", "Microsoft YaHei", system-ui, sans-serif;
  border-radius: 18px; overflow: hidden;
  border: 1px solid rgba(255,255,255,.16);
  background:
    linear-gradient(160deg, rgba(255,255,255,.10) 0%, rgba(255,255,255,.02) 42%, rgba(255,255,255,0) 100%),
    rgba(18, 20, 26, .78);
  -webkit-backdrop-filter: blur(26px) saturate(180%);
  backdrop-filter: blur(26px) saturate(180%);
  box-shadow: 0 24px 60px rgba(0,0,0,.62), inset 0 1px 0 rgba(255,255,255,.18), inset 0 -1px 0 rgba(0,0,0,.35);
  pointer-events: auto;
}
.vb-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid rgba(255,255,255,.09); }
.vb-title { font-weight: 600; letter-spacing: .2px; }
.vb-meta { color: #98a0b0; font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.vb-close {
  border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.06); color: #cfd3dc;
  width: 24px; height: 24px; border-radius: 10px; cursor: pointer; line-height: 1;
}
.vb-close:hover { background: rgba(255,255,255,.12); }

.vb-tabs { display: flex; gap: 8px; padding: 8px 14px 0; }
.vb-tab {
  flex: 1 1 0; display: flex; align-items: center; gap: 8px; justify-content: center;
  padding: 7px 10px; border-radius: 14px; cursor: pointer; color: #a8b0bf;
  border: 1px solid rgba(255,255,255,.10); background: rgba(255,255,255,.04);
  white-space: nowrap; transition: all .15s ease;
}
.vb-tab.is-active {
  color: #fff; border-color: rgba(96,165,255,.55);
  background: linear-gradient(180deg, rgba(96,165,255,.26), rgba(47,116,216,.18));
  box-shadow: inset 0 1px 0 rgba(255,255,255,.16);
}
.vb-tab small { opacity: .62; font-size: 11px; }

/* 固定高度 + 内部弹性：两个页签永远一样高 */
.vb-body { flex: 1 1 auto; min-height: 0; padding: 10px 14px 16px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; overflow-x: hidden; scroll-padding-bottom: 16px; }
/* 谁都不许被压扁：内容比面板高就交给 .vb-body 滚动。
   少了这一条，服务卡/三行终端会被 flex-shrink 压成 0 高——
   表现就是「就绪 · 点上面的开关才会启动服务」这行直接消失。 */
.vb-body > * { flex: 0 0 auto; }
/* 页签是唯一能长大的：窗口高时吃满剩余空间，内容超了照样滚动
   （原来写 flex: 1 1 auto 会被压缩，超出的部分既不滚动也看不见，滚到底也是假的） */
.vb-pane { flex: 1 0 auto; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.vb-card {
  border: 1px solid rgba(255,255,255,.10); border-radius: 16px; padding: 8px 12px;
  background: rgba(255,255,255,.045);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  box-shadow: inset 0 1px 0 rgba(255,255,255,.07);
}
.vb-line { display: flex; align-items: center; gap: 10px; }
.vb-label { color: #98a0b0; font-size: 12px; min-width: 58px; white-space: nowrap; }
.vb-value { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.vb-input, .vb-select, .vb-text {
  flex: 1 1 auto; min-width: 0; color: #e9ecf2; font: inherit;
  border: 1px solid rgba(255,255,255,.12); border-radius: 16px; padding: 6px 12px;
  background: rgba(255,255,255,.07);
}
.vb-select { cursor: pointer; }
.vb-text { min-height: 62px; resize: none; }

/* 选择文件：原生方角控件隐藏，换成圆角胶囊 */
.vb-pick { position: relative; flex: 1 1 auto; min-width: 0; display: flex; }
.vb-pick input[type=file] { position: absolute; inset: 0; opacity: 0; cursor: pointer; width: 100%; }
.vb-pickface {
  flex: 1 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px;
  border: 1px dashed rgba(255,255,255,.22); border-radius: 16px; padding: 6px 12px;
  color: #a8b0bf; background: rgba(255,255,255,.04); white-space: nowrap; overflow: hidden;
}
.vb-pick:hover .vb-pickface { border-color: rgba(96,165,255,.55); color: #dfe6f3; }
.vb-pickname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vb-pickb { margin-left: auto; color: #7fb4ff; flex: 0 0 auto; }

.vb-btn {
  border: 1px solid rgba(120,180,255,.55); border-radius: 999px; padding: 7px 18px; cursor: pointer;
  color: #fff; font: inherit;
  background: linear-gradient(180deg, rgba(96,165,255,.92), rgba(47,116,216,.92));
  box-shadow: 0 6px 18px rgba(47,116,216,.28), inset 0 1px 0 rgba(255,255,255,.28);
}
.vb-btn:disabled { opacity: .55; cursor: default; box-shadow: none; }
.vb-hint { color: #8b93a3; font-size: 12px; }
.vb-err { color: #ff8a80; font-size: 12px; white-space: pre-wrap; }
.vb-out {
  border: 1px solid rgba(255,255,255,.08); border-radius: 16px; padding: 10px 12px 12px;
  background: rgba(0,0,0,.22); white-space: pre-wrap; word-break: break-word;
  overflow: auto; min-height: 68px; scroll-padding-bottom: 12px;
}
.vb-out.is-tall { flex: 1 1 auto; min-height: 70px; }

/* 启停时的"运行输出"：固定三行、不可滚动、字号更小 */
.vb-console {
  border: 1px solid rgba(255,255,255,.10); border-radius: 14px; padding: 6px 9px;
  background: rgba(0,0,0,.42); font: 10px/1.5 Consolas, "Cascadia Mono", monospace;
  color: #9fb3c8; height: 48px; overflow: hidden;
  white-space: pre-wrap; word-break: break-all;
  display: flex; flex-direction: column; justify-content: flex-end;
}
.vb-console .vb-idle { color: #64748b; }
.vb-console .vb-cmd { color: #7fb4ff; }
.vb-console .vb-ok { color: #4cd964; }
.vb-console .vb-wait { color: #d9c37a; }

.vb-switch {
  position: relative; width: 46px; height: 26px; border-radius: 999px; flex: 0 0 auto;
  border: 1px solid rgba(255,255,255,.16); cursor: pointer; transition: background .2s ease;
  background: rgba(255,255,255,.12);
}
.vb-switch.is-on { background: linear-gradient(180deg, rgba(48,209,88,.95), rgba(39,184,74,.95)); border-color: rgba(60,220,110,.7); }
.vb-switch.is-busy { opacity: .6; }
.vb-knob {
  position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%;
  background: radial-gradient(120% 120% at 34% 16%, #fff 0%, #fff 46%, #eef1f5 100%);
  box-shadow: 0 2px 6px rgba(0,0,0,.35), inset 0 -1px 2px rgba(0,0,0,.10);
  transition: transform .22s cubic-bezier(.25,1.2,.4,1);
}
.vb-switch.is-on .vb-knob { transform: translateX(20px); }
`

    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID)) return
      const el = document.createElement('style')
      el.id = STYLE_ID
      el.textContent = STYLE_TEXT
      document.head.appendChild(el)
    }

    // 面板贴在胶囊（输入框左侧那排 chip）上方，向上长。
    // 但空会话时输入框可能落在窗口中间，上方只剩两三百像素 ——
    // 只按「上方空间」算就会被压成半高。那种情况改成贴窗口底
    // （会盖住输入行，按 × 或 Esc 关），保证面板本身先有足够高度。
    // 高度上限 = 窗口高 - 24，所以任何情况下都不会超出屏幕。
    // want = 这个面板想要多少高（语音面板 PANEL_H，部署面板只有一半）。
    function panelStyle(anchor, want) {
      const H = want || PANEL_H
      const vh = typeof window === 'undefined' ? 900 : window.innerHeight
      const vw = typeof window === 'undefined' ? 1200 : window.innerWidth
      const maxH = Math.max(320, vh - 24)
      let left = 12
      let bottom = 12
      let height = Math.min(H, maxH)
      if (anchor) {
        left = Math.min(Math.max(12, anchor.left - 12), Math.max(12, vw - PANEL_W - 12))
        const above = anchor.top - 14 // 胶囊上方真正能用的高度
        if (above >= 420) {
          bottom = Math.max(12, vh - anchor.top + 10)
          height = Math.min(H, above)
        } else {
          bottom = 12
          height = Math.min(H, maxH)
        }
      }
      return { left: left + 'px', bottom: bottom + 'px', height: height + 'px' }
    }

    async function api(path, body) {
      const r = await fetch(API + path, body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : undefined)
      const data = await r.json().catch(() => ({}))
      if (!r.ok || data.ok === false) {
        const err = new Error(data.error || `HTTP ${r.status}`)
        err.data = data
        throw err
      }
      return data
    }

    function toBase64(file) {
      return new Promise((resolve, reject) => {
        const fr = new FileReader()
        fr.onload = () => {
          const s = String(fr.result)
          resolve(s.slice(s.indexOf(',') + 1))
        }
        fr.onerror = () => reject(new Error('读取文件失败'))
        fr.readAsDataURL(file)
      })
    }

    function Switch(props) {
      const { on, busy, onClick } = props
      return h('div', {
        className: 'vb-switch' + (on ? ' is-on' : '') + (busy ? ' is-busy' : ''),
        onClick: busy ? undefined : onClick,
        title: on ? '点击停止服务' : '点击启动服务'
      }, h('div', { className: 'vb-knob' }))
    }

    // 圆角胶囊式的文件选择：原生 input 透明铺在上面，看不见方角
    function FilePick(props) {
      const { file, onChange, accept, hint } = props
      return h('div', { className: 'vb-pick' },
        h('div', { className: 'vb-pickface' },
          h('span', { className: 'vb-pickname' }, file ? file.name : (hint || '选择文件')),
          h('span', { className: 'vb-pickb' }, file ? '更换' : '浏览')
        ),
        h('input', { type: 'file', accept: accept || 'audio/*', onChange })
      )
    }

    function Panel(props) {
      const { onClose, anchor } = props
      const [tab, setTab] = useState('asr')
      const [status, setStatus] = useState(null)
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const [file, setFile] = useState(null)
      const [lang, setLang] = useState('Auto')
      const [text, setText] = useState('')
      const [out, setOut] = useState('')
      const [audioUrl, setAudioUrl] = useState('')
      const [refFile, setRefFile] = useState(null)
      const [refText, setRefText] = useState('')
      const [xvec, setXvec] = useState(false)
      const [consoleLines, setConsoleLines] = useState([])
      const boxRef = useRef(null)

      useEffect(() => { ensureStyles() }, [])

      const pull = () => api('/status').then(setStatus).catch(() => {})

      useEffect(() => {
        pull()
        const t = setInterval(pull, 8000)
        return () => clearInterval(t)
      }, [])

      useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        const onDown = (e) => {
          const box = boxRef.current
          if (box && !box.contains(e.target)) onClose()
        }
        document.addEventListener('keydown', onKey)
        const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
        return () => {
          document.removeEventListener('keydown', onKey)
          clearTimeout(t)
          document.removeEventListener('mousedown', onDown)
        }
      }, [onClose])

      const style = panelStyle(anchor)

      const asr = (status && status.asr) || {}
      const tts = (status && status.tts) || {}
      const cur = tab === 'asr' ? asr : tts
      const curPort = cur.port || (tab === 'asr' ? 8010 : 8011)

      // 启停时不只改按钮文案，还在小终端里逐行打真实状态：
      // 模型加载要 10–90 秒，没有输出会被误认为卡死。
      async function toggleModel() {
        const next = !cur.ok
        const kind = tab
        setErr('')
        setBusy(next ? '启动中…' : '停止中…')
        const dir = cur.dir || ''
        const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${dir}\\scripts\\serve.ps1" -Background -NoBrowser`
        const t0 = Date.now()
        const lines = []
        const push = (s, cls) => {
          lines.push({ s, cls })
          setConsoleLines(lines.slice(-3))
        }
        push('> ' + cmd, 'vb-cmd')
        push(next ? '等待服务就绪（模型加载通常 10–60 秒）…' : '正在停止服务…', 'vb-wait')

        let stopped = false
        const ticker = setInterval(async () => {
          if (stopped) return
          const s = await api('/status').catch(() => null)
          const m = s && s[kind]
          if (!m) return
          const sec = Math.round((Date.now() - t0) / 1000)
          if (next) push(`[${sec}s] :${m.port} ${m.ok ? '已就绪' : '等待中…'}`, m.ok ? 'vb-ok' : 'vb-wait')
          else if (!m.ok) push(`[${sec}s] :${m.port} 已停止`, 'vb-ok')
        }, 2000)

        try {
          await api('/model', { id: kind, enabled: next })
          push(next ? '完成：服务已就绪' : '完成：服务已停止', 'vb-ok')
        } catch (e) {
          setErr(String(e.message || e))
          push('失败：' + String(e.message || e), 'vb-wait')
        } finally {
          stopped = true
          clearInterval(ticker)
          setBusy('')
          pull()
        }
      }

      async function setIdle(minutes) {
        setErr('')
        try {
          await api('/model', { id: tab, idleMinutes: minutes })
        } catch (e) {
          setErr(String(e.message || e))
        }
        pull()
      }

      async function doTranscribe() {
        if (!file) { setErr('先选一个音频文件'); return }
        setErr(''); setBusy('识别中…'); setOut('')
        try {
          const audio = await toBase64(file)
          const r = await api('/transcribe', { audio, filename: file.name, mime: file.type, lang })
          setOut(r.text || '(空)')
        } catch (e) {
          setErr(String(e.message || e))
        } finally { setBusy('') }
      }

      async function doSpeak() {
        if (!text.trim()) { setErr('先写要朗读的文字'); return }
        setErr(''); setBusy('合成中…'); setAudioUrl('')
        try {
          const body = { text, lang, refText, xvec }
          if (refFile) {
            body.ref = await toBase64(refFile)
            body.refName = refFile.name
            body.refMime = refFile.type
          }
          const r = await api('/speak', body)
          if (r.audioUrl) setAudioUrl(r.audioUrl)
          setOut(r.status || '')
        } catch (e) {
          setErr(String(e.message || e))
        } finally { setBusy('') }
      }

      const serviceCard = h('div', { className: 'vb-card' },
        h('div', { className: 'vb-line' },
          h('span', { className: 'vb-dot ' + (cur.ok ? 'is-on' : 'is-off') }),
          h('span', { className: 'vb-value' },
            status ? `${cur.model || ''} · :${cur.port} ${cur.ok ? '在线' : '离线'}` : '检测中…'),
          h(Switch, { on: !!cur.ok, busy: !!busy, onClick: toggleModel })
        ),
        h('div', { className: 'vb-line', style: { marginTop: '8px' } },
          h('span', { className: 'vb-label' }, '闲置关闭'),
          h('select', {
            className: 'vb-select',
            value: String(cur.idleMinutes || 0),
            onChange: (e) => setIdle(Number(e.target.value))
          }, IDLE_CHOICES.map((n) => h('option', { key: n, value: String(n) }, `${n} 分钟`)),
            h('option', { key: 0, value: '0' }, '不自动关闭'))
        )
      )

      // 常驻显示：空的时候占位（否则一点开关才冒出来，会把下面的内容整体挤下去）
      const consoleBox = h('div', { className: 'vb-console' },
        consoleLines.length
          ? consoleLines.map((l, i) => h('div', { key: i, className: l.cls }, l.s))
          : h('div', { className: 'vb-idle' }, '就绪 · 点上面的开关才会启动服务'))

      const asrPane = h('div', { className: 'vb-pane' },
        h('div', { className: 'vb-card' },
          h('div', { className: 'vb-line' },
            h('span', { className: 'vb-label' }, '音频'),
            h(FilePick, { file, onChange: (e) => setFile(e.target.files && e.target.files[0]), hint: '选择音频文件' })
          ),
          h('div', { className: 'vb-line', style: { marginTop: '8px' } },
            h('span', { className: 'vb-label' }, '语种'),
            h('select', { className: 'vb-select', value: lang, onChange: (e) => setLang(e.target.value) },
              LANGS.map(([v, zh]) => h('option', { key: v, value: v }, zh)))
          ),
          h('div', { className: 'vb-line', style: { marginTop: '10px' } },
            h('button', { className: 'vb-btn', disabled: !!busy || !cur.ok, onClick: doTranscribe }, busy || '开始转写')
          )
        ),
        h('div', { className: 'vb-out is-tall' }, out || (busy ? '…' : '（识别结果会显示在这里）'))
      )

      const ttsPane = h('div', { className: 'vb-pane' },
        // 卡片自己长大：面板加高多出来的空间全给文字框，下面那块状态框保持固定高度
        h('div', { className: 'vb-card', style: { flex: '1 1 auto', display: 'flex', flexDirection: 'column' } },
          h('div', { className: 'vb-line', style: { flex: '1 1 auto', alignItems: 'stretch', minHeight: '62px' } },
            h('span', { className: 'vb-label' }, '文字'),
            h('textarea', { className: 'vb-text', value: text, placeholder: '要朗读的内容', onChange: (e) => setText(e.target.value) })
          ),
          h('div', { className: 'vb-line', style: { marginTop: '6px' } },
            h('span', { className: 'vb-label' }, '参考音频'),
            h(FilePick, { file: refFile, onChange: (e) => setRefFile(e.target.files && e.target.files[0]), hint: '可选，用于克隆音色' })
          ),
          h('div', { className: 'vb-line', style: { marginTop: '6px' } },
            h('span', { className: 'vb-label' }, '参考文本'),
            h('input', { className: 'vb-input', value: refText, placeholder: '参考音频说的内容（不勾声纹时必填）', onChange: (e) => setRefText(e.target.value) })
          ),
          // 语种和声纹勾选挤一行：朗读页控件多，这行省下的 26px 全给上面的文字框
          h('div', { className: 'vb-line', style: { marginTop: '6px' } },
            h('span', { className: 'vb-label' }, '语种'),
            h('select', { className: 'vb-select', value: lang, onChange: (e) => setLang(e.target.value) },
              LANGS.map(([v, zh]) => h('option', { key: v, value: v }, zh))),
            h('label', {
              className: 'vb-hint',
              title: '只用声纹（use x-vector），效果会差一些',
              style: { display: 'flex', alignItems: 'center', gap: '4px', flex: '0 0 auto', whiteSpace: 'nowrap', marginLeft: '2px' }
            },
              h('input', { type: 'checkbox', checked: xvec, onChange: (e) => setXvec(e.target.checked) }),
              '只用声纹')
          ),
          h('div', { className: 'vb-line', style: { marginTop: '8px' } },
            h('button', { className: 'vb-btn', disabled: !!busy || !cur.ok, onClick: doSpeak }, busy || '合成语音')
          )
        ),
        // 播放器给个固定矮高度：默认 54px 会把下面的状态框顶出面版
        audioUrl ? h('audio', { src: audioUrl, controls: true, style: { width: '100%', height: '36px' } }) : null,
        // 状态框固定五行：13px × 1.55 = 20.15 一行，5 行 = 100.75 → 内容区 101px
        h('div', { className: 'vb-out', style: { flex: '0 0 auto', height: '101px' } }, out || (busy ? '…' : '（合成状态会显示在这里）'))
      )

      return h('div', { className: 'vb-panel', style, ref: boxRef },
        h('div', { className: 'vb-head' },
          h('span', { className: 'vb-dot ' + (asr.ok && tts.ok ? 'is-on' : ((asr.ok || tts.ok) ? 'is-wait' : 'is-off')) }),
          h('span', { className: 'vb-title' }, '本机语音'),
          h('span', { className: 'vb-meta', style: { flex: '1 1 auto', textAlign: 'right' } },
            `ASR ${asr.ok ? '在线' : '离线'} · TTS ${tts.ok ? '在线' : '离线'}`),
          h('button', { className: 'vb-close', onClick: onClose, title: '关闭' }, '×')
        ),
        h('div', { className: 'vb-tabs' },
          h('div', { className: 'vb-tab' + (tab === 'asr' ? ' is-active' : ''), onClick: () => setTab('asr') },
            h('span', { className: 'vb-dot ' + (asr.ok ? 'is-on' : 'is-off') }),
            h('span', null, '转写'), h('small', null, 'Qwen3-ASR-1.7B')),
          h('div', { className: 'vb-tab' + (tab === 'tts' ? ' is-active' : ''), onClick: () => setTab('tts') },
            h('span', { className: 'vb-dot ' + (tts.ok ? 'is-on' : 'is-off') }),
            h('span', null, '朗读'), h('small', null, 'Qwen3-TTS-1.7B'))
        ),
        h('div', { className: 'vb-body' },
          serviceCard,
          consoleBox,
          tab === 'asr' ? asrPane : ttsPane,
          err ? h('div', { className: 'vb-err' }, err) : null
        )
      )
    }

    // 部署另一个模型：选目录 → 跑那个目录里的 install.bat / scripts\install.ps1
    function DeployPanel(props) {
      const { onClose, anchor } = props
      const [dir, setDir] = useState('')
      const [entry, setEntry] = useState('')
      const [busy, setBusy] = useState('')
      const [err, setErr] = useState('')
      const [lines, setLines] = useState([])
      const [running, setRunning] = useState(false)
      const boxRef = useRef(null)

      useEffect(() => { ensureStyles() }, [])

      useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose() }
        const onDown = (e) => {
          const box = boxRef.current
          if (box && !box.contains(e.target)) onClose()
        }
        document.addEventListener('keydown', onKey)
        const t = setTimeout(() => document.addEventListener('mousedown', onDown), 0)
        return () => {
          document.removeEventListener('keydown', onKey)
          clearTimeout(t)
          document.removeEventListener('mousedown', onDown)
        }
      }, [onClose])

      // 打开时先问一次上次的状态，部署中每 2 秒刷一次日志尾巴
      useEffect(() => {
        let alive = true
        const tick = () => api('/deploy/status').then((s) => {
          if (!alive) return
          setRunning(!!s.running)
          if (s.dir) setDir((d) => d || s.dir)
          if (s.tail) setLines(s.tail.split('\n').slice(-3))
        }).catch(() => {})
        tick()
        const t = setInterval(tick, 2000)
        return () => { alive = false; clearInterval(t) }
      }, [])

      // 部署面板只给一半高：半屏玻璃，够放目录 + 日志 + 一行说明
      const style = panelStyle(anchor, DEPLOY_H)

      async function pick() {
        setErr(''); setBusy('选择中…')
        setLines(['> 正在打开目录选择框…'])
        try {
          const r = await api('/deploy/pick', {})
          if (r.cancelled) { setLines(['> 已取消']); return }
          setDir(r.dir)
          setEntry(r.entry || '')
          setLines([
            '> ' + r.dir,
            r.ready ? '找到入口：' + r.entry : '没找到 install.bat / scripts\\install.ps1'
          ])
          if (!r.ready) setErr('这个目录不像部署包（缺 install.bat 与 scripts\\install.ps1）')
        } catch (e) {
          setErr(String(e.message || e))
        } finally { setBusy('') }
      }

      async function start() {
        if (!dir) { setErr('先选一个部署目录'); return }
        setErr(''); setBusy('启动中…')
        try {
          const r = await api('/deploy/start', { dir })
          setLines(['> ' + r.entry, '已启动，日志：' + r.log])
          setRunning(true)
        } catch (e) {
          setErr(String(e.message || e))
        } finally { setBusy('') }
      }

      return h('div', { className: 'vb-panel', style, ref: boxRef },
        h('div', { className: 'vb-head' },
          h('span', { className: 'vb-dot ' + (running ? 'is-wait' : 'is-off') }),
          h('span', { className: 'vb-title' }, '部署模型'),
          h('span', { className: 'vb-meta', style: { flex: '1 1 auto', textAlign: 'right' } },
            running ? '安装中…' : '未运行'),
          h('button', { className: 'vb-close', onClick: onClose, title: '关闭' }, '×')
        ),
        h('div', { className: 'vb-body' },
          h('div', { className: 'vb-card' },
            h('div', { className: 'vb-line' },
              h('span', { className: 'vb-label' }, '目录'),
              h('input', { className: 'vb-input', value: dir, placeholder: '选择一个含安装脚本的模型目录', onChange: (e) => { setDir(e.target.value); setEntry('') } })
            ),
            h('div', { className: 'vb-line', style: { marginTop: '10px' } },
              h('button', { className: 'vb-btn', disabled: !!busy, onClick: pick }, busy || '选择文件夹'),
              h('button', { className: 'vb-btn', disabled: !!busy || running || !dir, onClick: start, style: { marginLeft: '8px' } }, running ? '部署中…' : '开始部署')
            ),
            entry ? h('div', { className: 'vb-hint', style: { marginTop: '8px' } }, '入口：' + entry) : null
          ),
          // 日志框吃掉面板剩下的高度：下面那句说明就会一直贴在面板最底下
          h('div', { className: 'vb-console', style: { flex: '1 1 auto', minHeight: '48px' } }, lines.slice(-3).map((l, i) => h('div', { key: i }, l))),
          err ? h('div', { className: 'vb-err' }, err) : null,
          h('div', { className: 'vb-hint' },
            '会执行该目录里的 install.bat（或 scripts\\install.ps1），日志写在目录下的 deploy-*.log。')
        )
      )
    }

    // 一个入口组件，挂两个胶囊：语音 / 部署
    function Entry() {
      const [open, setOpen] = useState('') // '' | 'voice' | 'deploy'
      const [at, setAt] = useState(null)
      const [any, setAny] = useState(null)
      const ref = useRef(null)

      useEffect(() => {
        let alive = true
        const tick = () => api('/status').then((s) => {
          if (!alive) return
          setAny(!!(s.asr && s.asr.ok) || !!(s.tts && s.tts.ok))
        }).catch(() => {})
        tick()
        const t = setInterval(tick, 8000)
        return () => { alive = false; clearInterval(t) }
      }, [])

      const toggle = (which) => {
        const r = ref.current && ref.current.getBoundingClientRect()
        if (r) setAt({ left: r.left, top: r.top })
        setOpen((cur) => (cur === which ? '' : which))
      }

      const panel = (open && at)
        ? (open === 'voice'
          ? h(Panel, { anchor: at, onClose: () => setOpen('') })
          : h(DeployPanel, { anchor: at, onClose: () => setOpen('') }))
        : null

      return h('div', { ref, style: { display: 'inline-flex', gap: '6px' } },
        h('div', { className: 'vb-chip' + (open === 'voice' ? ' is-open' : ''), onClick: () => toggle('voice'), title: '本机 ASR / TTS' },
          h('span', { className: 'vb-dot ' + (any ? 'is-on' : 'is-off') }),
          h('span', null, '语音')
        ),
        h('div', { className: 'vb-chip' + (open === 'deploy' ? ' is-open' : ''), onClick: () => toggle('deploy'), title: '选择目录部署另一个模型' },
          h('span', null, '部署')
        ),
        panel && createPortal ? createPortal(panel, document.body) : panel
      )
    }

    function apply(ctx) {
      ensureStyles()
      // conversation.input.left 紧跟在「权限」「计划」两个 chip 右边
      return ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
        name: 'conversation.input.left',
        id: 'dsh-voice-bridge:chip',
        order: 20,
        inject: () => ({})
      }, Entry))
    }

    return { apply, inject: ['slots'] }
  }
})
