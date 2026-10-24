> 这是 **Voice Studio** 项目的其中一个部署包。整套东西怎么串起来，先看仓库根目录的 [README.md](../../README.md)。

# Qwen3-TTS-1.7B 一键部署包

双击 `install.bat`，等它跑完，浏览器会自动打开一个能用的语音合成界面。
不需要预装 Python，不需要配环境变量，不碰系统里已有的任何东西。

---

## 一、这个包装的是什么

| 项 | 值 |
| --- | --- |
| 模型 | `Qwen/Qwen3-TTS-12Hz-1.7B-Base`（阿里 Qwen3-TTS，12 Hz 双轨多码本） |
| 模型体积 | 约 4.3 GB（13 个文件：`model.safetensors` 3.7 GB + `speech_tokenizer/model.safetensors` 651 MB） |
| 推理库 | `qwen-tts 0.1.1`（PyPI 官方包，自带 Gradio 演示界面） |
| 运行时 | 包内自带 Python 3.11 嵌入式版 + PyTorch CUDA 12.8 |
| 显存占用 | 官方口径 1.7B 约 5–6 GB；12 GB 卡够用 |
| 默认端口 | `8011` |
| 监听地址 | `127.0.0.1`（只有本机能访问） |

它做的是**文字转语音**：给一段文字，输出 wav。官方说 1.7B 这一档首包延迟可到 **97 ms** 级；3 秒参考音频就能做音色克隆，8–15 秒更稳。

> 注意：仓库名带 `-Base`。`Qwen/Qwen3-TTS-12Hz-1.7B`（不带 `-Base`）在 HF 上是 401（私有/不存在），别手填错。

---

## 二、目录结构

```
Qwen3-TTS-1.7B\
├─ install.bat        ← 第一次用，双击这个
├─ start.bat          ← 以后启动
├─ stop.bat           ← 停止
├─ status.bat         ← 看是否在运行
├─ README.md          ← 本文件
├─ scripts\
│  ├─ install.ps1     ← 安装逻辑（bat 只是外壳）
│  └─ serve.ps1       ← 启停逻辑
├─ py\                ← 安装时生成：自带 Python
├─ models\            ← 安装时生成：模型文件
├─ download\          ← 安装时生成：Python 包等临时下载
└─ logs\              ← 安装时生成：运行日志
```

> `py\ models\ download\ logs\` 不用手动建，脚本会按需创建。

---

## 三、一键安装（第一次）

双击 **`install.bat`**。它会依次做：

1. **环境自检** — 64 位 Windows 10+、`curl.exe`、NVIDIA 驱动（`nvidia-smi`）、磁盘 ≥14 GB。
2. **准备 Python 3.11** — 从镜像下一个 11 MB 的嵌入式包（华为云 → npmmirror → 阿里云 → python.org 四个源依次试），解压、改写 `._pth`、装 pip。
3. **装 PyTorch** — CUDA 12.8 版（约 2.5 GB），失败自动换阿里云 pytorch-wheels。
4. **装 qwen-tts** — 从阿里云 PyPI 装 `qwen-tts==0.1.1`（连带 transformers、onnxruntime、librosa 等）。
5. **下模型** — 向 `hf-mirror.com` 要清单后逐文件下载，**每个文件都有进度条**。
6. **冒烟测试** — 打印 torch 版本、CUDA 可用性、显卡名、`qwen_tts` 能否 import。
7. **启动** — 等到 HTTP 200，打印地址并自动开浏览器。

中断了直接再双击一次：已完成步骤跳过、模型断点续传。

**和 ASR 包的关系**：两个包各自独立，各有自己的 Python 和 PyTorch（加起来约 9–10 GB）。这样做是因为 `qwen-asr` 要 `transformers==4.57.6`、`qwen-tts` 要 `transformers==4.57.3`，**版本冲突，不能共用一个环境**。

---

## 四、日常使用

| 想做什么 | 双击 |
| --- | --- |
| 启动 | `start.bat` |
| 停止 | `stop.bat` |
| 看状态 | `status.bat` |

启动后浏览器打开 `http://127.0.0.1:8011`。

命令行参数：

| 参数 | 作用 |
| --- | --- |
| `-Port 8011` | 换端口 |
| `-Listen 127.0.0.1` | 换监听地址（`0.0.0.0` 才允许局域网访问） |
| `-Foreground` | 前台运行（便于看日志） |
| `-NoBrowser` | 不自动开浏览器 |

---

## 五、出了问题怎么查

| 现象 | 先看 |
| --- | --- |
| 双击后闪一下就没了 | 用 `cmd` 进目录手敲 `install.bat`，报错会停住 |
| 卡在"下载卡住" | 网络断了，重跑续传 |
| 装 PyTorch 失败 | 把控制台最后 30 行发我 |
| 报 401 / 找不到模型 | 仓库名必须是 `Qwen3-TTS-12Hz-1.7B-Base`，带 `-Base` |
| 启动后打不开 | `status.bat` 看状态，`logs\` 里最新 `.err.log` 发我 |
| 显存不够 | 默认 GPU 加载；把报错发我，我给 CPU/半精度方案 |

---

## 六、这个包已验证 / 未验证的部分

**已验证**：

- 四个 `.ps1` 语法校验 0 错（PowerShell 5.1）。
- 四个 bat 纯 ASCII、调用路径正确。
- `install.ps1 -DryRun` 环境自检全绿、安装计划完整、退出码 0。
- 下载器逻辑（进度条、大小校验、多源切换、45 秒卡死检测）在本地 HTTP 服务上四情形测过。

**未验证**（需要你跑一次）：

- 公网真实下载（沙箱访问不了这些域名）。
- `qwen-tts` 装完后的合成效果、首包延迟、显存占用。
- `qwen-tts-demo` 的界面细节（只从入口点确认了参数：位置参数 ckpt、`--ip`、`--port`、`--device`、`--dtype`、`--no-flash-attn`）。

跑完把结果发我，我按实际情况改。

---

## 七、来源

- 模型：<https://huggingface.co/Qwen/Qwen3-TTS-12Hz-1.7B-Base>
- 官方包：`pip install qwen-tts`（<https://pypi.org/project/qwen-tts/>）
- 同系列还有 0.6B 档与 `-CustomVoice` / `-VoiceDesign` 变体（后者能用文字描述造音色），需要的话我另外打包。
