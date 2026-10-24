# 插件安装详解

桥接插件（`plugin/`）是一个 **DSH 插件**，不是独立程序，双击跑不起来。它只负责把本机的
Qwen3-ASR / Qwen3-TTS 接进 DSH 的界面。装它之前，两个语音服务应该已经能各自启动（见主 README 第 1 步）。

---

## 一、放目录

整个 `plugin/` 文件夹放在**任意稳定位置**都行，路径带空格也没关系：

```text
D:\dsh-voice-bridge\        ← 建议这样，短路径，好排查
├─ lib\
│  ├─ index.js            宿主半：HTTP 代理
│  └─ client.js           浏览器半：语音胶囊与浮层
├─ package.json
└─ cordis.patch.yml
```

> **不要**放进 DSH 安装目录 —— 升级 DSH 会把它覆盖掉。

---

## 二、登记到 profile

编辑 `%USERPROFILE%\.dsh\profiles\desktop\package.json`（profile 名不是 `desktop` 就换成实际的）：

```jsonc
{
  "dependencies": {
    "dsh-voice-bridge": "link:D:/dsh-voice-bridge"      // ① 路径用正斜杠
  },
  "dsh": {
    "profile": {
      "bundles": [
        // … 其他插件 …
        "dsh-voice-bridge"                              // ② 数组末尾加这一项
      ]
    }
  }
}
```

两个位置都要改：`dependencies` 让 DSH 知道去哪找包，`bundles` 让它真正被加载。

---

## 三、重启 DSH

**完全退出再打开**（彻底结束进程，不是关窗口）。插件只在启动时加载 —— 界面里的 Ctrl+R 只刷新渲染层，不会重载宿主半边。

启动时 DSH 通常会自动在 `node_modules\` 下建一个指向你目录的 junction。如果没建，手工补：

```powershell
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-voice-bridge" `
  -Target "D:\dsh-voice-bridge"
```

---

## 四、验证

重启后，输入框左侧（权限 / 计划模式那颗胶囊右边）应该多出一颗 **「语音」** 胶囊。点开能看到：

- 顶部两页签：**转写**（Qwen3-ASR-1.7B）、**朗读**（Qwen3-TTS-1.7B）
- 每页一个服务开关，右侧小字显示 `ASR 在线 · TTS 离线` 这类状态
- 黑色三行框是真实启动输出（`[2s] :8010 等待中…`）

如果胶囊没出现，先看 DSH 启动日志里有没有 `voice-bridge` 相关报错，再确认 `bundles` 里那行拼写。

---

## 五、改端口 / 改部署目录

不用动插件代码，改配置文件即可：`%USERPROFILE%\.dsh\voice-bridge\config.json`

```json
{
  "asr": { "port": 8010, "dir": "D:\\Qwen3-ASR-1.7B", "enabled": false, "idleMinutes": 10 },
  "tts": { "port": 8011, "dir": "D:\\Qwen3-TTS-1.7B", "enabled": true,  "idleMinutes": 10 }
}
```

宿主每次请求都重读这个文件，**面板下次打开就生效**，不需要重启 DSH。

---

## 六、卸载

1. 删掉 `dependencies` 里的 `"dsh-voice-bridge"` 那一行；
2. 删掉 `bundles` 里的 `"dsh-voice-bridge"`；
3. 删掉 `node_modules\dsh-voice-bridge` 这个 junction（**删的是链接，不是你的源码目录**，别用错命令）；
4. 重启 DSH。

两个语音服务的部署目录（`py\`、`models\`）可以单独留着，也可以直接删——它们与插件无耦合。
