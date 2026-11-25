# 第三方来源

本插件的千问办公登录、模型请求、流式响应和运行时发现代码改编自 [tianyn1990/qwenwork-magpie v0.1.0](https://github.com/tianyn1990/qwenwork-magpie/tree/v0.1.0)（提交 `8edf121209eae125c93523ede4d87c9801a1505f`）。上游采用 MIT 许可，版权声明及许可正文保留于 [LICENSE](./LICENSE)。

`lib/wasm.mjs` 的 wasm-bindgen 桥接代码改编自：

- 仓库：https://github.com/XuePengJu/dsh-our-free-model
- 固定提交：`71b55a985aa09940acc2b4f909da5c56f17097a0`
- 文件：`vendor/channel-pack/src/qwenwork-wasm.ts`
- 许可证：MIT，原 channel-pack 版权声明如下。

改动包括运行时发现与 ABI 检查、调用当前组件的身份材料生成器、按组件路径/时间缓存、释放请求结果和字符串，以及移除随包 WASM、钥匙串与登录文件相关依赖。登录与请求协议的研究也参考了同一提交下的 `qwenwork*.ts`，并与本机官方客户端 1.3.2 的公开随包代码作了核对。

本源码仓库包含 `.qwenwork-runtime/qoder-auth-wasm/qoder_auth_wasm_bg.wasm`，它原样提取自千问办公中国大陆版 2.1.0（`2.1.0-26111906`）官方桌面 App，大小为 288,929 字节，SHA-256 为 `15dad38f7d9744dabfdc8a892ebad80d2c8157779f4e33882123ab3c954f04d3`。本仓库不包含完整 App、用户凭据或客户端登录文件。Git 源码、对应源码归档和 npm 安装包均包含该组件。运行时默认自动加载，并通过 SHA-256 匹配其来源版本；显式配置仍可覆盖默认组件。

官方 WASM 组件不属于本项目 MIT 许可范围，相关权利归原权利人所有。本仓库的 MIT 许可证不授予该组件的使用、修改或再分发权利；使用及再分发需自行确认适用的官方许可与条款。

```text
MIT License

Copyright (c) 2026 Jet

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
