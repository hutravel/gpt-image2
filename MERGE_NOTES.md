# 上游合并记录

本次合并分支：`merge/upstream-v0.9.0`。
合并基线：`main`（`2350464`，fork v0.7.15）。
合入上游：`v0.9.0`（`5e1f5e7`，2026-11-07），共 152 个提交、308 个文件。

## 本次合入的上游功能

- Google（Gemini / Nano Banana）与 xAI（Grok Imagine）原生图像接口；OpenAI 兼容 Images API 也可用这两类模型，参数随模型 ID 自动切换。
- 参数栏按模型提供比例、分辨率、思考等级和质量选项，不支持的项置灰并说明原因。
- Gemini 可开启 Google Search / Image Search，任务详情展示搜索来源。
- 自定义服务商按模型配置接口（`modelOverrides`、`{model}` 占位符、`$inputImages.base64/urls`、JSON 字符串结果解析）。
- GPT Image 2.6 适配：复杂度、GIF 帧参数、SVG 输出、markup 独立标注图层。
- 画板（SketchBoard）与评论标注、遮罩编辑器统一风格。
- 隐私模式（默认 Ctrl+Shift+H）、外观配置（浅色/深色/跟随系统）、界面与代码字体选择。
- 多提示词批量提交、多模型切换（逗号分隔 + selectedModel）、失败任务原位重试（覆盖式/新建）。
- 数据导出导入进度与取消、导入配置链接逐项 diff 确认、画廊虚拟列表、图片二进制存储与旧数据后台迁移。
- Windows 桌面客户端（Tauri）：SQLite 存储、自绘标题栏、应用内更新、网络代理、数据目录迁移、CLI `gpt-image-playground` 与随附 Skill；部署工作流（deploy.yml）保留 fork 的跳过上游 release 校验逻辑，并合入桌面端 `workflow_run` 触发与签名密钥。

## 保留的 fork 决策

- Image Paint 品牌、提示词广场及全部本地数据源、同步脚本；Header/App 的广场入口。
- 输入框 `@图N` 缩略图提及（getImageMentionTagHtml），采纳上游基于记录选区的插入方式（IME 修复）。
- `model` 是唯一模型来源（含 Responses 图像工具），`imageGenerationModel` 仅作旧数据兜底；相关上游测试已按此语义调整。
- 新配置默认模型 `gpt-image-2`、Base64 开启（tri-state 保留，record 未设置时回落到 createDefault 的 true）、超时 600 秒；skill 文档与 LLM 提示词同步改为 `gpt-image-2`。
- Worker 图片代理路由保留，与上游 `apiFetch`（Tauri 感知）合并。
- 移除 Agent 对话界面、设置、动作、专用 API 及测试；`SettingsTab` 无 `agent` 页；`db.ts` 保留旧 `agentConversations` store 的原样存取以保护历史图片引用（`LegacyConversationRecord`）。
- 隐私模式快照无 agent 字段；`hasInterruptibleOperations(tasks, batchProgress)` 无对话参数。
- CLI 设置键列表去掉 agent 相关键。

## 验证

- `tsc --noEmit` 0 错误（源码 + 测试）。
- `vitest run`：63 个文件、869 项通过（1 项跳过）。
- `npm run build` 生产构建通过（大 chunk 提示与上游一致）。
- 浏览器交互验收与真实出图 API 未执行。
