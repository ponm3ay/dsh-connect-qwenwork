# dsh-connect-qwenwork

把[千问办公](https://qwenwork.cn/)（QwenWork）接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：用自己的千问办公账号在浏览器授权，然后在 DSH 的模型选择器里直接选模型。

这是 [pi-qwenwork-provider](https://github.com/ErkundenSie/pi-qwenwork-provider) 的 DSH 移植版。上游插件给 Pi / Pi Web 用，这一版按 DSH 的插件契约重写了接入层：供应商注册、模型发现、设置页、凭据存储都换成了 DSH 的接缝，协议适配、WASM 签名和流式解码沿用上游（MIT，见 `THIRD_PARTY_NOTICES.md`）。

## 特点

- **浏览器授权，无需 API Key。** 打开授权页 → 完成授权 → 插件自动轮询拿到 token，不用粘贴验证码。
- **进程内回环反代，无常驻进程。** 本机 `127.0.0.1` 上起一个只认 OpenAI chat completions 的小服务，把 DSH 的请求改写成千问办公要的签名请求。不需要 magpie、不需要单独守护进程、不需要记端口。和 dsh-connect-autoclaw / workbuddy / qoder 用的是同一个模式。
- **随附官方签名组件。** 按 SHA-256 识别千问办公 2.1.0 的官方 WASM 组件并自动使用对应版本，换机器或移动插件目录都不用重配。
- **模型目录跟随账号。** 授权后读一次账号的模型目录，可在设置页手动刷新；读不到时用内置快照，不会把模型选择器清空。
- **凭据不出本机。** 存在 `$DSH_HOME/.qwenwork-auth.json`（0600）。设置页的浏览器那一半永远拿不到 token。

## 安装

**插件市场 / 本地目录：** 在 **插件** 里添加这个包的目录，安装后重启 DSH。

**手动登记：** profile 的 `package.json` 依赖里加 `"dsh-connect-qwenwork": "link:D:/.dsh/plugins/dsh-connect-qwenwork"`，`dsh.profile.bundles` 里加 `"dsh-connect-qwenwork"`，然后 `pnpm install`。

包自带 `cordis.patch.yml`，只 insert 一行插件，不改 profile 的默认模型。

## 使用

1. **设置 → 千问办公** → **登录**，在浏览器完成授权。
2. 新会话的模型选择器里选一个千问办公模型。

详细说明（模型表、思考开关、输出预算、环境变量、排查）见 [docs/DETAIL.md](docs/DETAIL.md)。

## 开发

```sh
npm test
```

测试用桩替换上游传输和签名器，不联网、不扣积分；真实 WASM 组件会被加载并验签，用来确认随附组件本身可用。

## 结构

| 文件 | 作用 |
| --- | --- |
| `lib/index.js` | 插件入口：注册供应商、模型发现、设置页路由 |
| `lib/adapter.mjs` | pi-ai 模型描述 + `PiAiAdapter`，指向回环 shim |
| `lib/shim.mjs` | 127.0.0.1 上的 OpenAI 形状小服务，转发签名请求 |
| `lib/store.mjs` | 本机凭据，串行轮换 |
| `lib/catalog-store.mjs` | 账号模型目录，落盘缓存 |
| `lib/login.mjs` | 一次浏览器授权的完整流程 |
| `lib/panel.mjs` | 设置页的宿主端路由 |
| `lib/client.js` | 设置页的浏览器端 |
| `lib/constants.mjs` `account.mjs` `catalog.mjs` `chat.mjs` `wasm.mjs` `runtime.mjs` `errors.mjs` | 上游协议适配层（MIT） |

## 许可证

MIT。协议适配代码来自 [pi-qwenwork-provider](https://github.com/ErkundenSie/pi-qwenwork-provider)，其协议适配又基于 [qwenwork-magpie](https://github.com/tianyn1990/qwenwork-magpie/tree/v0.1.0)。千问办公官方 WASM 组件不在本项目许可范围内。

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
