# 上游合并记录

本次合并分支：`merge/upstream-v0.9.1`。
合并基线：`main`（`6f08238`，fork v0.9.0-fork.1；与上游 merge-base 为 `6f8f44d`，v0.9.1 的前 4 个文档提交已含于 fork）。
合入上游：`v0.9.1`（`5d5c3b7`，2026-11-13），新增 4 个提交。

## 本次合入的上游功能

- 字节跳动（Ark / Seedream 5.5）原生图像接口：生成与参考图编辑（最多 10 张）、PNG/JPEG 格式、自动/透明/不透明背景、水印开关（默认关闭）。
- 分辨率选项扩展：Seedream 支持 1K / 1.5K / 2K 三档、预设比例、自定义比例与宽高，超限自动规整；`size.ts` 新增 `SEEDREAM_RESOLUTIONS` 与规整函数。
- `shouldReturnBase64()`：xAI（x.ai）、字节跳动（volces.com / bytepluses.com）官方域名默认开启 `response_format: b64_json`，显式设置优先于域名默认；`responseFormatB64Json` 改为 true/false/undefined 三态。
- 自定义服务商 JSON 请求修复（图生图不再误发 multipart）；`normalizeContentType` 接受 `json`。
- 设置说明行高修复（`leading-6`）；网页版操作指南移除导入链接说明（客户端保留）；预置配置默认模型同步 `gpt-image-2.6-sunburst`。
- 新增公告卡片 models-intro-3（Gemini / Grok / Seedream）；CLI 支持 Seedream 尺寸、水印与背景参数（新增 `cliBridge.test.ts`）。

## 冲突解决（8 个文件）

- `apiProfiles.ts` / `openaiCompatibleImageApi.ts`：采纳上游三态 base64 与 `shouldReturnBase64`，保留 fork 的 `responseFormatUrl`（「返回 URL」开关）互斥语义与云函数转发；`createDefault*Profile` 不再硬编码 `responseFormatB64Json: true`。
- `SettingsModal.tsx`：保留 ForkApiSettings（无 API Key/URL/模型 ID 输入框）与 fork 服务商白名单（无 sub2api/fal），合入「字节跳动」选项、Base64 开关的 bytedance 支持与 `leading-6`。
- `inputParamsPanel.tsx`：恢复 fork 无 agent 钩子的数量输入，套用上游 `family !== 'seedream'` 条件；Seedream 专属格式/背景/水印控件自动合入。
- `package.json` / `package-lock.json` / `sw.js` / `RELEASE.md`：版本号统一 `0.9.1-fork.1`，缓存名 `gpt-image-playground-v0.9.1-fork`，RELEASE.md 按 fork 格式重写。

## Fork 适配

- `ForkApiSettings.tsx`：MODEL_CATALOG 新增 bytedance 分组（`doubao-seedream-5-5-261028`），模型弹窗标题支持「字节跳动」。
- 云函数转发 Seedream：`usesImageApiWorkerProxy` 经 `getImageModelFamily` 的 seedream 分支自动覆盖；新增 `getWorkerProxyPathPrefix`（bytedance 用 `api/v3`，其余 `v1`），请求与轮询的代理 URL 及 `getProxyUpstreamBaseUrl` 版本段剥离同步区分；`deploy/fc/index.py` 白名单增加 `/api/v3/images/generations|edits`（Bearer 认证），`smoke_test.py` 补 ark 转发用例（已通过）。
- 服务商切换经 `switchApiProfileProvider` 的 bytedance 分支自动带入 Ark 默认地址与模型、`transparentBackgroundMethod: 'api'`。

## 验证

- `tsc -b` 0 错误（源码 + 测试）。
- 云函数冒烟 `python -I smoke_test.py` 通过（含 ark 路径）。
- 其余验证（vitest / build / 浏览器交互）见提交前记录。

## 云函数部署提醒

`deploy/fc/index.py` 变更后需在阿里云函数计算重新部署 `gpt-image-aqzuoonyeh` 函数，否则 bytedance 官方域名的云函数转发返回 404（经中转站的 OpenAI 兼容场景不受影响）。
