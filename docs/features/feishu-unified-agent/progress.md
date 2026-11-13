# 实施进度

## 2026-11-13 · v0.11.0

### 真实现状与发现

基线v0.10.2，开始时工作区干净。Next.js 16 / React 19 / Node 24 / SQLite；launcher启动Web与worker。已有应用通过SDK 1.76长连接处理私聊资料；雷达通知实际经自定义Webhook。原入口未持久化应用/租户/会话范围，普通文字默认收录，PDF/模型与雷达串行执行。本轮修正这些边界，保留RAG、OCR、原始资料、任务、用量和雷达规则。

### 已实现

- `server/feishu/unified-store.ts`：身份、授权、场景、稳定事件编号/快照、消息与资料关联、交接、路由/发送账本。
- `unified-router.ts`：群事实问答/对照/交接；私聊查询/资料分析/收藏/暂停；普通会话分开留存。
- `receiver.ts`、`config.ts`：应用+租户事件/消息去重、兼容迁移、私有回复映射、入口和出站授权复查。
- `runtime.ts`：沿用SDK，新增应用群发送；确定性目标、网络超时、文字上限，无新回调或公开URL。
- `radar-delivery.ts`、`notifications.ts`：逻辑目标去重、平台确认、尝试日志、unknown保护、切换/回滚与历史截止点。
- `worker-lanes.ts`、`worker.ts`、`engine.ts`：原runs按有界槽领取，发送/接收独立，worker进程锁。
- `observation/theme-types.ts`、`theme-engine.ts`：仅补条件来源ID，不改检测阈值、规则、选股和任务频率。
- `scripts/feishu-unified.ts`、`config/feishu-unified.example.json`：默认预览，支持只读探测、绑定校验、停机切换/回滚。
- 新增22项隔离测试，更新原资料入口测试为真实v2身份结构；更新README/CHANGELOG/TESTING/案例说明及版本。

### 已验证

239项程序测试、类型检查、生产构建、浏览器回归通过，具体场景见acceptance.md。已有应用凭据和机器人身份通过真实只读接口核验；群列表缺有效群信息读取权限，返回99991672。没有调用付费模型做本轮测试，没有重置或提升预算。

已在本机备份原数据库/资产（backups，排除密钥）；新表与inbox兼容迁移已在隔离测试及本机诊断载入。未清空旧数据或重放旧消息。真实身份候选仅在忽略提交的data目录，不进入公开文档。

本机程序已重载v0.11.0，HTTP、worker心跳与既有飞书长连接正常；重载没有切换雷达通道或恢复暂停任务。

### 尚未上线的统一群通道

生产推送保持旧Webhook；新统一身份绑定未激活。没有真实群测试、生产路由切换、主动私聊、卡片回调或旧凭据删除。平台权限发布状态和目标群/租户须核对。既有任务启停、频率、范围未改变。

### 下一步与恢复入口

先读本文件、plan.md和acceptance.md，再读receiver / unified-store / radar-delivery的实际代码。不要靠聊天历史假定切换已经完成。

1. `npm run feishu:unified -- status` 核对当前路由、绑定、未决消息和worker状态。
2. 提供可信群/租户ID，或开通群信息读取权限并发布后重新 `npm run feishu:unified -- probe`。不需新建应用或重填秘密。
3. 用户确认稳定身份后，按plan.md停止旧worker、保存绑定；在单独授权测试目标验收真实群@/私聊链路。
4. 用户明确批准生产切换后，用实际route version执行switch；回滚也需停机和未决检查，不清账本。

缺少上述绑定与真实联调授权时，代码和测试可交付，但不得声称生产统一机器人已接通。
