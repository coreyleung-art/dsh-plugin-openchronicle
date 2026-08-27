# Changelog · dsh-plugin-openchronicle

## [0.1.1] - 2026-08-28

### 修复
- 补全 peerDependencies（dsh-tools/cordis），修复 CLD 启动崩溃

## [0.1.0] - 2026-08-28

### 首版：感知记忆层（OpenChronicle 吸收 X3 混合方案）
- 直接 spawn Swift mac-ax-helper 二进制 → 结构化 JSON 捕获（复用 OpenChronicle 成熟 AX 捕获，去 Python/MCP 中间层）
- 7 工具：oc_capture / oc_current_context / oc_search / oc_memories / oc_snapshot / oc_timeline / oc_share
- 记忆：按天 Markdown 聚合（~/.dsh/openchronicle/）+ 文件/大小上限控制
- 节流：定时捕获默认 10min（环境变量可调，0=不自动）
- S3 时间线：状态迁移去重（同内容 30min 内合并，AriadneMem 式）
- S5 跨设备：oc_share 同步黑板 data/perception/ 通道
