# 安全说明

## 这个插件持有什么

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| 访问令牌、刷新令牌、`uid`、`machineId` | `$DSH_HOME/.qwenwork-auth.json`（0600） | 登录后写入；退出登录即删除 |
| 模型目录缓存 | `$DSH_HOME/.qwenwork-models.json.catalog`（0600） | 公开信息，缓存只是为了少发请求 |
| 逐模型开关与覆盖 | `$DSH_HOME/.qwenwork-models.json`（0600） | 本机偏好 |

这些文件都在 `$DSH_HOME` 下，不在仓库里，也不在 profile 的设置文件里。

## 令牌不会去的地方

- **浏览器。** 设置页的浏览器半只问「登录了没」「开始登录」「落地了没」，从不接收令牌。
- **日志。** 错误信息经过 `redact()`，Bearer 值、JWT、刷新令牌会被替换。授权流程里抛出的异常还会额外按已知秘密做一次替换。
- **请求体。** 签名后的信封里不含原始访问令牌；上游的 `is_vl` 等标志由签名组件生成。

## 回环路由

设置页的九个路由挂在宿主端口上，每个请求都要过 `lib/http-fence.mjs` 的两层检查：

1. 宿主自己的 `connection.requestRejection`（如果这个 DSH 提供了）；
2. 本地重申：Host 头必须是回环地址（`127.0.0.0/8`、`localhost`、`::1`），`Sec-Fetch-Site: cross-site` 一律拒绝，带 `Origin` 时必须同源。

所以局域网地址、DNS 重绑定页面和跨站请求都到不了登录路由。

## 签名组件

`.qwenwork-runtime/qoder-auth-wasm/qoder_auth_wasm_bg.wasm` 是千问办公官方客户端随附的组件，**不在本项目的 MIT 许可范围内**，见 `THIRD_PARTY_NOTICES.md`。插件按 SHA-256 识别它，并校验它导出的符号；ABI 不匹配时会在发出任何请求之前报错。

插件不关闭 TLS 校验，不启动对公网监听的端口，不读取官方桌面 App 的登录文件。

## 报告问题

发现安全问题请开 issue 描述影响面，不要在 issue 里贴真实令牌或账号信息。如果问题涉及凭据泄露路径，先退出登录（设置页「退出登录」会删除凭据文件）再报告。
