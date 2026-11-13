# 实现与运行说明

2026-11-13，增量实现于 v0.10.2，完整约束见 spec.md。一个应用身份，两类会话；不改变雷达选股、阈值、频率、期限或任务启停。

## 模块职责

| 模块 | 本轮职责 / 复用 |
| --- | --- |
| `feishu/config.ts`、`runtime.ts` | 原应用凭据和 SDK 1.76 长连接；静态卡片回复、应用群文本发送、网络超时与字节上限 |
| `feishu/unified-store.ts` | 严格身份/环境/任务范围；E编号、历史事件、消息映射、交接与路由账本 |
| `feishu/receiver.ts` | SDK已认证事件快速持久化；应用+租户+事件/消息去重；处理及发送前重新鉴权 |
| `feishu/unified-router.ts` | 群确定性事实工具，私聊资料/收藏/暂停；普通会话最多3轮独立上下文 |
| `feishu/radar-delivery.ts`、`notifications.ts` | 复用持久outbox，逻辑目标去重、尝试/平台ID、受控迁移与回滚 |
| `worker.ts`、`worker-lanes.ts` | 雷达、资料、飞书、回顾、其他作业各1槽；接收/发送独立；进程锁与心跳 |
| `library/*`、`observation/*` | 复用检索、引用校验、纠正删除、任务管理、既有事件和数据快照 |

ThemeEvent仅增加 conditionIds 追踪字段，合并事件保留条件集合，不改变检测算法。旧事件缺标识不声称是同一条件的“上次”。市场事实不因删除个人收藏而改写。

## 数据与兼容

SQLite自动建立 `feishu_scopes`（应用/租户/用户/会话/话题/事件与消息ID）、`radar_event_refs`（数据库内唯一E编号）、`feishu_event_messages`（多消息映射）、`feishu_private_refs`、`feishu_handoffs`（本人绑定30分钟）、`feishu_event_records`、`feishu_event_deliveries`（事件+逻辑目标）、`feishu_delivery_meta/attempts`、`feishu_radar_route/route_audit`。原信号仍是事实来源；原检查保留规则版本、数据快照与发生/采集时间。日期缺失就明确标未知，不用当前行情覆盖。

旧inbox只移除消息ID的跨应用全局唯一限制，原行完整复制；新消息用应用+租户去重。旧Webhook没有可靠平台ID，不补建虚构映射。统一入口不把旧无身份封套的私聊卡片作为新范围内的可信回复绑定；可重新发送记录编号。原始输入、资料及用量保留。

资料分析复用最多3份资料的 `answerRecords` 和 `library_run_sources` 版本失效机制；收藏事件将原始请求与市场快照分开，metadata保存来源引用；重复收藏关联同一记录，新的说明作为批注，不创建监控。普通对话仅留会话日志，不进入长期资料检索。群路由不调用资料工具或模型。没有主动私聊/卡片回调，交接用文字码；不把“已建立交接”说成“已发送”。

## 配置和最小权限

沿用 `data/feishu-app-credentials.json`，不要重建应用；新非密钥绑定保存在 `data/feishu-unified.json`，同样禁止提交公开仓库。模板见 `config/feishu-unified.example.json`：现有appId、tenantKey、ownerOpenId、botOpenId、radarChatId、明确taskIds、environment、enabled。测试使用临时库+test环境；生产必须production，不能交叉发送。普通设置保存不自动改变这个绑定。

统一绑定不存在：仅保留原来单一授权用户的私聊，拒绝群处理。绑定存在但错误/禁用：统一入口拒绝，不回退。统一配置文件存在时，原私人周报/任务摘要不再发旧群Webhook，仍在本机查看，待单独批准私聊通知目的地。

| 能力 | 权限/事件与当前核验 |
| --- | --- |
| 应用身份 | 真实只读token获取、bot/v3/info成功；未打印凭据 |
| 指定群接收 | `im.message.receive_v1` + `im:message.group_at_msg:readonly`，控制台开通与发布状态待核实。仅有该权限时，回复也应 @机器人 |
| 私聊接收 | `im:message.p2p_msg:readonly` + 同一事件，沿用既有配置；本轮未重做真实收件 |
| 发送/回复 | `im:message:send_as_bot`，机器人须有目标群发言权限；新群发送待授权真实测试 |
| 获取已收到的附件 | 保留现有消息资源接口及 `im:message:readonly` 等对应已有授权；不是仅添加 `im:resource` 就能下载任意用户文件 |
| 群元数据探测（可选） | 本轮群列表返回99991672；需有效的群信息读取权限之一，推荐核对 `im:chat:read`。也可直接提供可信群ID/租户ID，无需为此申请全部群消息或通讯录 |
| 交互卡片 | 未接回调；仅静态卡片/文字指令，无失效按钮，不需要新增card.action.trigger |
| 主动私聊 | 未实施；用本人私聊发送H码接续，不推断最近私聊对象 |

官方核验（2026-11-13）：[消息API/资源与权限](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1)、[群@与私聊接收FAQ](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/guide/faq)、[事件认证、v2标识和重投](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide)、[SDK长连接](https://open.feishu.cn/document/ukTMukTMukTM/uYDNxYjL2QTM24iN0EjN/event-subscription-configure-)。安装SDK的类型定义核对了message.create/reply参数、receive_id_type=chat_id及message_id返回值；EventDispatcher会合并v2 header与event。

长连接认证由SDK处理，不开新公网HTTP接收端点；接收函数只校验和同步落库，耗时工作交后台。官方文档说明事件可能重复投递，采用本地双重幂等。SDK支持出站uuid；本轮可读官方资料未能确认当前出站uuid有效期和跨接口范围，因此**不依赖它保证重试安全**，仍用永久业务账本、未知结果停重发策略。平台code=0且返回消息ID记作sent（创建获确认），不代表已读。

## 可复现操作

```sh
npm run backup
npm run feishu:unified -- status
npm run feishu:unified -- probe
```

probe只读应用身份/群元数据，候选写本机 `data/feishu-identity-candidates.json`，不自动按名称或首个群绑定。API Key/App Secret不用重填，不进入前端。群权限变更须在飞书控制台发布生效；入群本身不证明接收、发送或回调可用。

1. 把模板复制到本机私有路径，填入核验后的身份与授权任务。统一入口启用须显式设置enabled=true。以下configure默认仅校验，不保存：

```sh
npm run feishu:unified -- configure --file data/feishu-unified.draft.json
```

2. 经用户确认绑定后，停止当前launcher（前台Ctrl+C；后台先用`ps -axo pid,command`确认本项目launcher PID，再SIGTERM），检查旧worker、LaunchAgent/其他调度脚本均已停止，等待心跳离线。CLI另外检查进程、锁与心跳。不停止/恢复任何雷达任务的业务状态。

```sh
npm run feishu:unified -- configure --file data/feishu-unified.draft.json --apply --confirm-verified-binding
npm run build
npm start
```

3. 在用户明确授权的测试目标做真实群发送/回复/私聊验收。当前不自动发群测试，也不插入合成市场事件。测试使用单独测试配置/数据库；生产E编号须来源真实事件。群测试授权与生产切换授权分开。

4. 核对旧outbox。queued/sending/unknown均阻止切换；先由旧通道完成或核对真实平台结果，绝不删除未知记录“解锁”。暂停发送者并等待离线后预览：

```sh
npm run feishu:unified -- switch --to app
```

5. 用户批准后，以status显示的实际版本替换N执行。原子更新路由版本/切点，保留事件、已发状态和旧凭据，只发切点后的新事件，不补发历史：

```sh
npm run feishu:unified -- switch --to app --expected-version N --apply --authorized-production-switch
npm start
```

回滚仍先停worker、核对未决消息，以新版本号执行同一命令 `--to webhook`；不清账本、不删除凭据、不恢复旧数据库覆盖新数据。二进制恢复与数据库恢复属于单独维护操作；本轮备份在本机backups，秘密文件需保留原件。

Mac休眠/离线/worker停止时无法接收或调度，不宣称云端常驻。作业通道是同进程有界异步并发，不是独立CPU服务；各通道最多1个作业，现有模型用量预算继续生效。发送串行排队，无限重试与渠道兜底均禁用。


## v0.11.1：没有触发信号时的真实检查联调

复用 `observation_checks` / `observation_frames`，以 `radar_check_refs` 分配R编号；`feishu_check_messages`记录应用/租户/群消息到原检查的映射。不会写入observation_signals，不修改检查快照。receiver发送前检查范围，统一router在查私人资料前处理检查事实。基线明确说明是比较起点，不推断所有股票均未达条件。

```sh
npm run feishu:check-test
# 仅在用户明确授权测试目标后执行；不切换正式路由
npm run feishu:check-test -- --send-authorized
```

可用 `--run` 指定授权任务下已有检查，默认取最新有效主题检查。生产拒绝合成帧；脚本默认预览。发送业务键包含应用/租户/群/原检查，重复执行返回已有状态，unknown不重发；测试通知有独立kind与账本，不参与正式信号调度。真实用户回复发送消息后沿平台事件进入worker，无需伪造入站做联调。

R事实回复展示原始时间、主要缺口、有限核心股票的当时条件；过长时明确范围。仅同任务、同配置和同轮次才可比较。同群30分钟内无其他信号干扰且只有一份检查时，可解析“刚才那个”；其他情况使用回复关系或澄清，不跨聊天猜最近对象。

R当前不支持私人联合分析或收藏，询问时如实提示；已有E信号能力保留。完整群快照联调通过仍不授权生产路由切换。
