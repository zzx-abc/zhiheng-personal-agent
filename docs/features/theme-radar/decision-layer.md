# 雷达决策层实施说明（v0.12.0）

本轮不是策略有效性验证。目标是把有效不满足、数据不够和模式不适用分开，让用户先看重要风险与研究候选；数据不足时保留具体阻塞。

## 代码核查

| 原因 | 改动与验证边界 |
| --- | --- |
| relativeMet把3/5日、当前强度、量能合成一个boolean/null | `conditions.ts`五态原子与组合；3/5日独立留数值、单位、日期、质量及证据，FAIL不被UNKNOWN掩盖 |
| quoteUsable在盘后仍要求10分钟内，组合仍需intradayRelative | `mode.ts`区分模式、目标交易日、最后可用日和历史窗口；`formalDaily`要求最终标记、对应日线、收盘后取得且不晚于判断时点；盘后current原子不参与组合 |
| 数据源将finalPrice/finalVolume固定为false | 此处没有改为true。正式数据适配能力仍未取得；新流程在可靠提供者具备对应证据时可正常计算，现有腾讯源只能保留快照与可用历史 |
| validUntil必须非空；所有未核验都显示“可能过期” | 未设截止日不推定过期；sourceDate、validUntil、comparability/verification/verifiedThrough及reviewStatus分别检查 |
| 离线/恢复清空基线 | 主题状态持久化；离线不重置，恢复保留，显式配置新版本仍建立基线；兼容语义升级静默，不回填市场事件 |
| R详情只显示前四核心股票 | 全量排序；风险优先；详情每页一股或按证券名，含辅助与待核验对象 |
| 有检测事件，没有策略动作定义 | `strategy-schema.ts`草稿与启用校验；`strategy.ts`确定性动作、假设场景和风险/机会序列 |
| 应用推送text、Webhook text，默认回复长条件日志 | 应用和Webhook主题摘要统一原生interactive卡片；普通通知仍沿用原格式；详细证据/诊断通过文字命令或本机查看 |

实际库只读检查：当前主题任务没有启用完整strategy；已有个人价格线尚无完成的当期可比性核验。轮次不是检查次数，不能据“轮次3”断言三次重建基线；此次查到的主题配置仅一条基线检查。本说明不公开私人价位或凭据。

## 数据结构与职责

- `Atom`：id、label、status、actual、threshold、unit、window、quality、reasons、evidence。证据包含源URL、availableAt、frameId和操作数。
- `Condition`：原兼容met仍在；新增status、atoms、combination(required/failed/blocked)、snapshot描述及validation复核。snapshot始终与可执行确认分开。
- `EvaluationMode`：mode/basisMode、asOf、targetDate、lastAvailableDate、historyEnd、formalHistory；不将抓取时间替代行情时间。
- `Strategy`：版本、适用周期/场景/模式、entry/cancel/hold/reduce/exit条件组、确认阶段、入场价格区间、风险说明、量能/板块角色、验证状态。没有完整定义就不启用；不填写用户仓位偏好。
- `Action`：稳定code和用户标签分开，保存假设对象、规则版本、证据阶段、时点、主要理由、下一确认、失效条件、阻塞及来源。启用规则的声明验证状态须带依据，但程序不替代策略有效性评审。
- `DecisionReport`：完整risks/opportunities/others、排序原因、策略草稿/缺参数。入库在原检查detail.themeReport里，无新独立服务或模型调用。
- `ThemeState.evaluationVersion`：语义升级时该条件初次静默；随后沿原不同时间观察点、连续确认、episode和去重账本运行。不会因换一种说法重复提醒。
- `interpretation`：旧报告的只读衍生结果；原库detail不覆盖，不能作为当前交易提醒。

可用条件ID包括relative（组合）、relative3、relative5、confirmation、current、volume、high（组合）、highPrice以及配置对应price-N组合。关闭的组合不提供启用后的子条件；未知ID阻塞动作。量能和板块若为必需，作为额外AND门；OR价格条件不能绕过确认阶段。后续交易日确认必须匹配该证券的对应条件，不能借用另一个条件的连续记录。

## 观察线复核路径

在“持续观察 → 调整配置 → 维护主题、股票与规则”选择主题。

1. 保留原symbol、price、sourceDate和basis，核对用户设定来源与有效期。validUntil=null只表示没有设置到期，不是自动过期。
2. 核查目标证券除权等可比性，记录真实依据到verification，设置comparability=verified和verifiedThrough。若已有reviewStatus，完成后设verified；未完成保持pending/needs_review。
3. enabled=false或reviewStatus=disabled明确停用；恢复需有有效核验。不存在自动验证服务，界面不会声称已后台核查。
4. 保存新主题版本，再明确采用到任务。配置变化只建基线，不冒充新行情，也不调整原价位。

复核状态和下一步保存在每个条件validation。当前路径是用户/维护者提交核验依据，不是已实现自动除权因子校验。

## R-1固定输入前后对照

**以下均为用户提供、未经本次独立行情核验的测试输入；生成的其余日线只是隔离计算夹具，不是历史行情。**

| 对象 | 旧语义 | 新语义 |
| --- | --- | --- |
| 凡拓数创 .43 / 6.33，对1 / 1 | 组合缺当前确认，整体UNKNOWN | 3日FAIL、5日PASS；组合FAIL并单列待核验 |
| 鼎龙股份 .89 / -1.39，对1 / 1 | 历史不达标被其他缺口淹没 | 两项FAIL；快照58.93对历史线60.55只做位置描述，收盘/价位核验未完不算新卖出 |
| 富瀚微24.46 / 16.84、星宸科技15.64 / 10.76 | 固定顺序列诊断 | 历史项PASS，研究顺序优先；仍缺当前确认和完整入场规则，不确认买点 |
| 江丰电子209.04对205.16、安集科技218对222 | 统一“未核实或过期” | 分开显示快照位置、缺可比性及正式价；未设到期不推定过期 |
| 宇树科技缺价格 | 容易被当整个主题无结论 | 保留对象及缺口；具身智能1/2，不做主题整体判断 |

示例第一层摘要（约280字，实际以预览输出为准）：

> 知衡｜策略观察
> 2026-11-13 · 盘后复盘，正式收盘待核验 · 固定样本，本地预览
> 当前判断：本次建立基线，先看风险再筛机会；已知条件单独呈现，不称为新增信号。
> 风险优先：鼎龙股份，快照58.93元低于历史观察线60.55元；先核验收盘与价位适用性。复核既有风险计划，不据缺失数据卖出或确认安全。
> 机会优先：端侧AI·富瀚微、星宸科技，历史3/5日指标满足。先核验当前确认与入场/取消规则，暂不确认买点。
> 暂缓判断：具身智能可比1/2只，不作主题整体判断。
> 当前只有机会筛选规则，尚无完整买卖策略；未读取个人持仓。

`npm run radar:preview`生成同一模板的HTML、原生卡片JSON、手机PNG和鼎龙样本证据页到本机artifacts。不是飞书客户端截图，不调用模型、不读生产库、不发送消息；完整证据显示每项FAIL/UNKNOWN、区间与URL，不在摘要重复诊断。

## 飞书入口和平台核查

2026-11-14核对官方文档：[Webhook发送卡片](https://open.feishu.cn/document/feishu-cards/quick-start/send-message-cards-with-custom-bot)、[消息卡片参考](https://open.feishu.cn/document/historical-version/interactive-session-based-robot/message-card-content-reference)、[卡片交互配置](https://open.feishu.cn/document/feishu-cards/configuring-card-interactions)。采用已在项目使用的v1 header/div/plain_text结构；Webhook的card与应用API的content JSON分别封装，不假定普通文本支持Markdown表格。

没有实现回调按钮，底部明确是**回复文字指令**，不是虚假可点击按钮。应用通道可回复并@机器人；Webhook附E编号，@应用机器人并带编号查询，原Webhook本身不能接收入站。R编号仍是检查，不创建伪E信号。查询“查看证据 第2页”、按股票名查、“查看全部对象”、“运行诊断”；私聊可带编号，个人资料权限沿原模块。开发电脑localhost不冒充手机可访问详情链接。

## 保留的限制

- 真实腾讯适配器没有正式收盘确认/可靠全天量标志、可比分钟量；这些强条件真实场景依然UNKNOWN。不能靠本轮整改把当前源变成权威最终日线。
- 完整买卖策略没有用户参数；入场、取消、持有、减仓、退出、风险边界仍是未启用草稿。配置接口可用，示例策略只在隔离测试证明映射，不用于生产。
- 行情、持仓、产业证据互不代替；群不读取私人持仓。没有新账户或下单接口，没有目标价/胜率计算。
- 自动提醒仍由原有效事件和outbox去重驱动；未添加单独的“每次动作文案变化”推送，不增加频次。
- 2027日历、自动除权核验、供应商稳定性/覆盖仍未补齐。真实客户端卡片显示和新有效市场事件闭环本轮未外发验收。
