# dsh-plugin-openchronicle

**感知记忆层**：调 Swift mac-ax-helper 捕获屏幕/应用上下文 → JSON 记忆 → 检索工具。

OpenChronicle 吸收 X3 混合方案：复用其成熟 AX 捕获二进制，去 Python/MCP 中间层，数据归一化到统一记忆。

## 工具
- `oc_capture` — 手动捕获一次（当前前台 app 或全部可见）
- `oc_current_context` — 查「用户此刻在做什么」（实时捕获）
- `oc_search` — 检索历史捕获记忆（关键词）
- `oc_memories` — 列出记忆文件

## 环境变量
| 变量 | 默认 | 说明 |
|------|------|------|
| OC_HELPER_PATH | 自动探测 | mac-ax-helper 路径 |
| OC_MEM_DIR | ~/.dsh/openchronicle/ | 记忆目录 |
| OC_CAPTURE_INTERVAL_MIN | 10 | 定时捕获间隔（0=不自动）|
| OC_SAVE_RAW | 0 | 1=同时存原始 JSON |

## 依赖
- OpenChronicle 已安装（提供 mac-ax-helper 二进制）— 或单独编译 Swift helper
- macOS（AX 捕获仅 mac）
