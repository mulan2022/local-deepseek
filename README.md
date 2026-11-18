# Local DeepSeek · 本地对话

## [⬇️ 下载 Android 安装包（APK）](https://github.com/mulan2022/local-deepseek/releases/latest/download/DeepSeek-Local-Chat.apk)

**当前版本 v0.1.12 · Android 8.0 及以上** · [本次发布](https://github.com/mulan2022/local-deepseek/releases/tag/v0.1.12) · [更新日志](CHANGELOG.md) · [English](README.en.md)

无需自建后端的聊天客户端，提供 Android 应用和静态网页版。支持 DeepSeek、Kimi、Claude、OpenAI、Gemini、GLM、Qwen 和自定义兼容接口。对话、附件和聊天记忆保存在当前设备，使用自己的 API Key 直连所选服务商。

聊天、附件、语音、Dream、对话压缩和截图识别会把所需内容发送给对应 API 服务商，并可能产生调用费用。切换服务商后，后续请求会发送当前会话所需的上下文；本地保存不代表模型在本机运行。

## v0.1.12 更新

- **修复旧版 WebView 白屏**：补齐移动端页面高度的兼容回退，修复关闭 API 设置后聊天区域高度变成 0 的问题。
- **多模型与对话搜索**：配置各平台 API、获取模型列表并切换；关键词搜索显示标题和匹配语句，点击可跳转到对应消息。
- **悬浮聊天与截图**：安卓小窗口保留输入栏和回复区，支持截图预览和延迟截图；修复悬浮捕获画面及图片工具结果的接口兼容问题。
- **AI 自主 Heartbeat**：支持秒级延迟、重复间隔、指定时间和每日唤醒。沿用原会话的上下文、记忆及已启用工具，AI 可以安排下一次唤醒。
- **Token 用量与对话压缩**：显示 API 返回的用量；手动压缩前确认，自动压缩可关闭，提供 200K、967K 和自定义阈值，保留用户原话及本地原始记录。
- **记忆与工具修复**：统一聊天与唤醒的工具提供方式；RCC 标明历史发言，压缩后保留工具供模型按需检索。

完整说明见 [更新日志](CHANGELOG.md)。

## 在 Android 上使用

1. 下载上方 APK 并安装。系统提示时，允许当前浏览器或文件管理器安装应用。同签名旧版可直接覆盖安装以保留本地对话，无需先卸载。
2. 在 **设置 → 模型与 API** 配置服务商和 API Key，获取模型列表或手动填写模型 ID。DeepSeek Key 也可在 **数据管理** 中填写。
3. 迁移历史时，在 **数据管理 → 导入历史对话** 选择 DeepSeek 导出的 ZIP 并确认。导入成功后会替换本机全部会话和附件，导入期间可以查看处理进度。
4. 跨会话记忆在左侧 **聊天记忆** 入口管理；手机能力在 **设置 → 手机工具** 分别开启。

安装最低要求为 Android 8.0（API 26）。建议更新系统 WebView；功能还取决于 WebView 内核、系统权限和设备厂商的后台策略。

## 功能

- 流式回复、多会话、编辑重发、重新生成和切换消息分支。支持 Markdown、代码高亮、公式和 Mermaid。
- DeepSeek Flash 支持专用的联网搜索、附件和思考接口；其他平台的模型能力以其 API 为准。
- 关键词匹配本地对话，显示标题和匹配片段，点击后定位到消息。
- 分层聊天记忆、常驻记忆、行为观察、实体和 Dream。模型可通过记忆工具检索历史；导入后的首次 Dream 可手动选择最多 10 个会话。夜间自动整理需要应用仍在运行并保持联网。
- 记忆注入按会话冻结，其他窗口新增记忆不会改写当前会话已发送的历史前缀；服务商是否实际命中缓存仍由其接口和缓存策略决定。RCC 中的历史发言作为背景资料处理，来源编号只在按需检索时返回。
- Token 用量来自 API 返回的 usage，区分会话累计与单次请求用量，未返回用量时不伪造精确值。
- 手动、自动 Compact。单独的摘要请求整理会话，用户原话由代码使用 `////` 拼接。后续请求使用摘要、用户原话和新消息，不重复携带原始记忆注入，仍保留记忆搜索等工具。本地原始聊天记录可以继续查看。
- 本地 ZIP 导入与导出。导出包含会话和本机可用的图片原件，API Key、应用设置、聊天记忆和非图片附件原件需另行保管。[归档格式与保留范围](src/services/chat/history/README.md)

### 安卓手机工具

在 **设置 → 手机工具** 分别选择允许的能力：

- **屏幕捕获**：经安卓屏幕共享授权后，AI 可读取当前画面，或等待 0–60 秒后截图。可在设置或悬浮窗口预览实际画面。支持图片的模型直接读图，其他模型需要 DeepSeek Key，由 Flash 返回画面描述。
- **快捷操作**：打开网页、地图、拨号、短信、邮件、闹钟、日历和系统分享界面。拨号、发送和保存等操作由用户在对应系统界面完成。
- **Heartbeat**：AI 为当前会话设置延迟一次、定点一次、按间隔重复或每日定时唤醒，也可以在设置中手动管理。延迟和间隔最短 1 秒；唤醒作为应用事件进入普通聊天，沿用会话模型、上下文、记忆和当前启用的工具。
- **悬浮聊天**：授权悬浮窗后，在其他应用上方显示精简聊天窗口，支持移动、展开和关闭，继续使用同一份会话。

前台、悬浮聊天或共享屏幕时按计划触发 Heartbeat；进入后台后可能受安卓调度、网络和电池策略影响，秒级设置不保证后台精确定时。受保护内容或不可见的共享应用可能无法截屏，预览会提示当前状态。

网页版也可设置功能开关和计划，屏幕共享、系统快捷操作、悬浮窗及后台唤醒由安卓客户端执行。

## 本地运行网页版

需要 Node.js 22.12+ 和 pnpm。

```sh
git clone https://github.com/mulan2022/local-deepseek.git
cd local-deepseek
pnpm install
pnpm dev
```

打开 [http://localhost:8090](http://localhost:8090)。运行 `pnpm build` 构建静态文件到 `dist/`，`pnpm type` 和 `pnpm lint` 检查源码。浏览器和 Android 应用分别保存本地数据，可通过 ZIP 迁移会话。网页版使用外部 API 时还受服务商的跨域策略限制。

在 Windows 上可使用 JDK 21、Android SDK Platform 35 和含 `aapt2`、`D8`、`zipalign`、`apksigner` 的 Android SDK Build Tools 构建 Android 版本。

```powershell
./scripts/build-android.ps1 -Jdk 'C:/path/to/jdk' -BuildTools 'C:/path/to/build-tools' -AndroidJar 'C:/path/to/android-35/android.jar'
```

安装包输出到 `build/DeepSeek-Local-Chat.apk`，构建脚本使用本地调试签名。覆盖安装需要沿用原安装包的签名。签名密钥不随源码发布。

## 来源与许可

这是基于 [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo) 的社区项目，与 DeepSeek 官方无隶属关系。聊天记忆与 Dream 提示词适配自用户提供的 DSH 插件；当前蓝色鲸鱼图标为本项目使用 AI 生成的插画。代码许可见 [MIT License](LICENSE)。
