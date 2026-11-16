# Local DeepSeek

## [⬇️ Download the Android APK](https://github.com/mulan2022/local-deepseek/releases/latest/download/DeepSeek-Local-Chat.apk)

**v0.1.8 · Android 8.0 or later** · [Releases](https://github.com/mulan2022/local-deepseek/releases) · [简体中文](README.md)

A community-maintained Android and static web client based on [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo). Conversations, attachments, and chat memory are stored on the current device. Chat, attachments, voice features, and Dream send the required content directly to the DeepSeek API. Bring your own API key.

1. Install the APK and enter your DeepSeek API key in **Settings → Data**.
2. To migrate history, select **Import chat history** and choose the ZIP exported by DeepSeek. A successful import replaces local conversations and attachments.
3. Enable chat memory if you want cross-chat search or Dream. The first Dream after a history import lets you select up to 10 conversations. Nightly Dream requires the app to remain running and online.

The app supports streaming responses, multiple conversations, prompt edits and resends, reply regeneration, message branches, and local history export. See the [archive format](src/services/chat/history/README.md) for which data is included.

## Run locally

```sh
git clone https://github.com/mulan2022/local-deepseek.git
cd local-deepseek
pnpm install
pnpm dev
```

Open [http://localhost:8090](http://localhost:8090). Use `pnpm build` to create the static site in `dist/`. See the [Android build instructions](README.md#本地运行网页版) for Windows.

The whale icon is adapted from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-primitives/src/FishLogo.tsx). This project is unaffiliated with DeepSeek. See the [MIT license](LICENSE).
