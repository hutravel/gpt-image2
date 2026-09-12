# 上游合并记录

本地分支：`merge/upstream-v0.7.12`。
原 fork 基线：`main`（`ae44923`）。
合入上游：`v0.7.12`（`da4fda85b59ecacc51d6a1e2ef680e3abb9e29b8`）。

原 fork 为独立导入，未与上游共享 Git 祖先。本分支以该上游版本为基础，迁回 fork 的功能与配置。

## 保留与调整

- 保留 Image Paint 品牌、提示词广场及本地数据源、同步脚本。
- 保留输入框 `@图N` 缩略图、预览、替换和引用顺序映射，并保留上游 IME/光标修复。
- 保留 Base64 配置导入、请求与响应选项、自定义异步端点、模型 ID 设置。
- 新配置默认模型为 `gpt-image-2`，Base64 开启、URL 返回关闭，超时为 600 秒；已有配置的显式值继续保留。
- `gpt-image-2.5-sunburst`、`gpt-image-2.5-flare` 的质量为 `auto/low/medium/high/xhigh/max`，不提供 `ultra`。底层计时 API 按需将秒转换成毫秒。
- 移除 Agent 对话界面、设置、动作、专用 API 及测试；模式为 `gallery | square`。普通图库的 Responses/Codex CLI 兼容功能保留。
- 历史任务、图片及收藏继续兼容。旧会话数据库不删除，旧 localStorage 数据隔离保留，图片清理保护其引用。

## 验证

- 生产构建通过；Vite 仍有大体积 chunk 提示。
- 全量测试通过：27 个文件、405 项。
- 浏览器自动化受本机沙箱 ACL 故障影响，未完成交互验收；未调用真实付费出图 API。

改动仅位于本地合并分支，尚未提交或推送。
