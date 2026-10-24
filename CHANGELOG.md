# 更新日志

版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-10-24

首个公开版本。

### 新增

- **桥接插件** `dsh-voice-bridge`：在 DSH 输入框左侧挂一颗「语音」胶囊，点开为固定高度的玻璃浮层，
  分「转写 / 朗读」两页，各自带服务开关与闲置自动停服。
- **宿主代理**：`/voice-bridge/api/{status,config,transcribe,speak}` 四个端点，负责上传音频、
  走 Gradio 的 `call` + SSE、把结果转成 JSON。浏览器侧因此不用处理跨域。
- **Qwen3-ASR-1.7B 一键部署包**：自带 Python 3.11 + PyTorch CUDA 12.8，四镜像回退下载，模型断点续传，
  装完自动起服务并开浏览器。默认端口 `8010`。
- **Qwen3-TTS-12Hz-1.7B-Base 一键部署包**：同上，默认端口 `8011`，支持参考音频音色克隆与「只用声纹」模式。
- **配置文件** `%USERPROFILE%\.dsh\voice-bridge\config.json`：端口、部署目录、开关持久状态、闲置分钟数，
  宿主每次请求重读，改完无需重启。

### 已知限制

- 仅 Windows + NVIDIA（CUDA）验证过。
- 非流式：整段处理完才出结果。
- `-Base` 模型不含内置音色，必须先给参考音频。
- 安装后两个部署包各自带一份 PyTorch，合计约占 19 GB 磁盘（仓库里只有约 94 KB 脚本），因为 `qwen-asr` 要 `transformers==4.57.6`、
  `qwen-tts` 要 `transformers==4.57.3`，版本冲突无法共用环境。
