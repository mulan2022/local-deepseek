# Local DeepSeek · 本地对话

## [⬇️ 下载 Android 安装包（APK）](https://github.com/mulan2022/local-deepseek/releases/latest/download/DeepSeek-Local-Chat.apk)

**当前版本 v0.1.8 · Android 8.0 及以上** · [版本记录](https://github.com/mulan2022/local-deepseek/releases) · [English](README.en.md)

无需自建后端的 DeepSeek 聊天客户端，提供 Android 应用和静态网页版。对话、附件和聊天记忆保存在当前设备。发送消息、处理附件、使用语音或运行 Dream 时，客户端会把所需内容直接发送给 DeepSeek API。使用前需要自己的 API Key。

## 在 Android 上使用

1. 下载上方 APK 并安装。系统提示时，允许当前浏览器或文件管理器安装应用。已安装同签名旧版时，可直接覆盖安装以保留本地对话。
2. 打开 **设置 → 数据管理**，填写 DeepSeek API Key。
3. 迁移历史时，在同一页选择 **导入历史对话**，选择 DeepSeek 导出的 ZIP 并确认。导入成功后会替换本机全部会话和附件，导入期间可以查看处理进度。

## 功能

- 流式回复、多会话、编辑重发、重新生成和切换消息分支。
- 深度思考、搜索、附件、语音输入和朗读。支持 Markdown、代码高亮、公式和 Mermaid。
- 可选的跨会话记忆。可以保存常驻记忆，让模型通过 `mem_search` 按需检索旧对话，或用 Dream 整理聊天记忆。导入后的首次 Dream 可手动选择最多 10 个会话。夜间自动整理需要应用仍在运行并保持联网。
- 本地 ZIP 导入与导出。导出包含会话和本机可用的图片原件，API Key、应用设置、聊天记忆和非图片附件原件需另行保管。[归档格式与保留范围](src/services/chat/history/README.md)

## 本地运行网页版

需要 Node.js 22.12+ 和 pnpm。

```sh
git clone https://github.com/mulan2022/local-deepseek.git
cd local-deepseek
pnpm install
pnpm dev
```

打开 [http://localhost:8090](http://localhost:8090)。运行 `pnpm build` 可构建静态文件到 `dist/`，`pnpm type` 和 `pnpm lint` 可检查源码。浏览器和 Android 应用分别保存本地数据，可以通过 ZIP 迁移会话。

在 Windows 上可使用 JDK 21、Android SDK Platform 35 和含 `aapt2`、`D8`、`zipalign`、`apksigner` 的 Android SDK Build Tools 构建 Android 版本。

```powershell
./scripts/build-android.ps1 -Jdk 'C:/path/to/jdk' -BuildTools 'C:/path/to/build-tools' -AndroidJar 'C:/path/to/android-35/android.jar'
```

安装包输出到 `build/DeepSeek-Local-Chat.apk`，构建脚本使用本地调试签名。自行构建时，覆盖安装需要沿用原安装包的签名。

## 来源与许可

这是基于 [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo) 的社区项目，与 DeepSeek 官方无隶属关系。鲸鱼图标改自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-primitives/src/FishLogo.tsx)。代码许可见 [MIT License](LICENSE)。
