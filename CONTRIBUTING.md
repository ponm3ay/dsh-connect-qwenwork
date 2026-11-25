# 贡献指南

## 环境

Node 22.19 或更高。插件本身没有运行时依赖，跑测试不需要安装任何东西：

```sh
node --test test/
node scripts/client.mjs
node scripts/validate-manifest.mjs
```

`npm run check` 一次跑完上面三样。

## 需要 DSH 运行时的检查

有四个脚本要对着真实的 DSH 运行时跑，因为它们验证的是「插件交给 pi-ai 的东西，pi-ai 认不认」。它们从已安装的 DSH 里抽出运行时到临时目录：

```sh
node scripts/extract-runtime.mjs ./.rt/node_modules
cd .rt && node ../scripts/smoke.mjs
```

| 脚本 | 验证什么 |
| --- | --- |
| `scripts/smoke.mjs` | 一条真实 chat 走通 `PiAiAdapter` → shim → 签名 |
| `scripts/capabilities.mjs` | 上下文、图片、思考强度三项覆盖真的落到模型描述和签名信封 |
| `scripts/mount.mjs` | 在真实 Cordis Context 里挂载，路由注册、围栏、释放 |
| `scripts/client.mjs` | 浏览器半按 `__ModuleLoader__` 契约加载并渲染三种状态 |

## 结构

宿主半在 `lib/`，按职责分：

- **协议层**（`constants` `account` `catalog` `chat` `wasm` `runtime` `errors`）：千问办公的线上事实。这些是从 [pi-qwenwork-provider](https://github.com/ErkundenSie/pi-qwenwork-provider) 移植的，改动时请保持与上游可对照。
- **状态层**（`store` `catalog-store` `model-state`）：本机持久化。凭据、目录缓存、逐模型覆盖各一个文件。
- **解析层**（`model-resolve`）：目录事实 + 用户覆盖 → DSH 看到的模型。这是唯一做这个合成的地方，别在别处再拼一次。
- **传输层**（`shim` `adapter`）：回环服务和 pi-ai 描述。
- **界面层**（`panel` `panel-view` `http-fence` `http-json` `client.js`）：设置页的宿主路由、载荷形状、安全围栏和浏览器半。

浏览器半 `lib/client.js` 是一个自包含的 `__ModuleLoader__` 工厂，不能用 `import`——它只 `require("react")`。

## 约定

- **能力只有一个来源。** 任何地方要判断「这个模型支不支持图片 / 上下文多大 / 思考强度多少」，都必须走 `catalog.listResolved()` 或 `resolveModel()`，不要直接读目录条目。否则界面和请求会各说一套。
- **测试不能假绿。** 新增断言时先让它失败一次，确认它抓的是真问题。`scripts/client.mjs` 里那条「结果必须被渲染」的检查就是这么验证的。
- **错误要分档，不要把「不确定」说成「坏了」。** 网络失败、超时、限流都不是模型的错，见 `probe.mjs` 的判定表。
- **不要凭记忆写 token。** 界面只用 `design-platform.css` 里真实存在的 `--dsw-*` 变量，并且每个都带字面兜底。

## 提交

一个提交说清一件事。涉及行为的改动带测试；涉及界面的改动带截图（`docs/assets/`）。
