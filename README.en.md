# Local DeepSeek

## [⬇️ Download the Android APK](https://github.com/mulan2022/local-deepseek/releases/latest/download/DeepSeek-Local-Chat.apk)

**v0.1.12 · Android 8.0 or later** · [This release](https://github.com/mulan2022/local-deepseek/releases/tag/v0.1.12) · [Changelog](CHANGELOG.md) · [简体中文](README.md)

A community-maintained Android and static web client based on [DeepSeek chat-demo](https://github.com/deepseek-ai/chat-demo). No application backend is required. Conversations, attachments, and memory are stored on the current device. Bring your own API keys for DeepSeek, Kimi, Claude, OpenAI, Gemini, GLM, Qwen, or a custom compatible API.

Chat, attachments, voice, Dream, compaction, and screen analysis send required content to the corresponding API providers and may incur charges. Switching providers sends the context needed for subsequent requests to the new provider. Local storage does not mean local model inference.

## What's new in v0.1.12

- Fix a blank chat screen after closing API settings on WebViews without dynamic viewport unit support.
- Configure and switch models; fetch model lists or enter model IDs. Search local titles and message snippets, then jump to a matching message.
- Use a compact floating chat window on Android, preview captured screens, and request delayed screenshots. Fix screen capture dimensions and image tool results alongside DeepSeek search.
- Let the AI schedule its next Heartbeat in seconds, at a clock time, or on a repeating schedule. Wakeups continue the same conversation with its context, memory, and enabled tools.
- Display API token usage and compact conversations manually with confirmation or automatically at 200K, 967K, or a custom threshold. Original user messages and local history are preserved.
- Share tools between ordinary chats and Heartbeat when memory is enabled. Treat recalled messages as historical material; after compaction, keep recall tools without reinjecting the original memory context.

See the [changelog](CHANGELOG.md) for details.

## Getting started

1. Install the APK. Update an existing version signed with the same key in place, without uninstalling.
2. Open **Settings → Models & API**, configure your provider and key, and choose a model. The DeepSeek key can also be entered in **Data** settings.
3. Select **Import chat history** and choose a ZIP exported by DeepSeek. Successful import replaces local conversations and attachments.
4. Manage memory from the sidebar and enable Android capabilities individually under **Settings → Phone tools**.

The APK requires Android 8.0 / API 26 or later. Keep the system WebView updated; actual behavior also depends on permissions and device background policies.

## Features and limitations

Streaming, prompt edits and resends, regeneration, message branches, Markdown, code highlighting, math, and Mermaid are supported. DeepSeek Flash uses dedicated web search and attachment APIs; other capabilities depend on each provider.

Memory includes pinned instructions, sections, observations, entities, and Dream. The first Dream after importing history lets you select up to 10 conversations. Nightly Dream requires the app to remain running and online. Existing conversations keep their memory injection snapshot; provider cache hits still depend on provider policy.

Compaction runs a separate summary request. User messages are joined by code using `////`; subsequent requests use the summary, user messages, and new turns, with tools available for recall. Original local history stays readable. Token displays use API-reported usage; cumulative usage differs from the latest request's context size.

Optional Android phone tools:

- Screen capture requires Android screen-sharing consent. Screenshots can be delayed by 0–60 seconds and previewed locally. Image-capable models receive images; other models require a DeepSeek key for Flash to describe the screen.
- Shortcuts open URLs, maps, dialer, SMS, email, alarms, calendar, and the share sheet. Users complete calls, sending, and saving in the system UI.
- Heartbeat supports one-off delays, one-off clock times, intervals, daily schedules, and cancellation, starting at one second. Wakeups continue the original conversation. Android scheduling, connectivity, and battery policies may delay background execution.
- Floating chat requires overlay permission and preserves the same conversation when moved or expanded.

Web builds expose the same switches and schedule settings; screen sharing, shortcuts, overlays, and background wakeups execute in the Android client. Protected screen content may be unavailable.

ZIP exports include conversations and locally available image originals. API keys, settings, memory, and original non-image attachments need separate backup. See the [archive format](src/services/chat/history/README.md).

## Run locally

Requires Node.js 22.12+ and pnpm.

```sh
git clone https://github.com/mulan2022/local-deepseek.git
cd local-deepseek
pnpm install
pnpm dev
```

Open [http://localhost:8090](http://localhost:8090). Use `pnpm build` to build `dist/`, `pnpm type` for type checks, and `pnpm lint` for linting. Browser access to external APIs depends on their CORS policies. Browser and Android installations store data separately.

See the [Android build instructions](README.md#本地运行网页版) for Windows. Output: `build/DeepSeek-Local-Chat.apk`. Reuse your signing key for in-place updates; signing keys are not published.

Memory and Dream prompts are adapted from the user-provided DSH plugin. The blue whale illustration was generated with AI for this project. This project is unaffiliated with DeepSeek. See the [MIT license](LICENSE).
