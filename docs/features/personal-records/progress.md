# 进度（v0.8.0）

## 已完成
- library资产、收录、版本、片段、主张、批注、关联、检索、纠正和删除；原对话与资料入口接通。
- 文字、PDF文字层、公网HTTPS网页处理，保留原件；部分失败与处理上限明确展示。
- 飞书官方SDK授权收件、去重、回复绑定与持久化outbox适配。
- 180项程序测试、类型检查、生产构建、完整浏览器隔离回归全部通过。
- 一次真实Kimi提取及实际网页读取通过；真实PDF文字层和本地E5向量测试通过。详情见acceptance.md。

## 尚未验证与限制
v0.10.2本机已通过自建应用的真实资料收件、附件下载、处理和发送回执验证；新部署仍须自行配置App ID/Secret与授权用户open_id，仓库不含凭据。群Webhook不能代替收件应用。v0.10已补图片与扫描PDF本地OCR；复杂表格理解和全文分块语义向量未实现；每轮最多12片段，部分结果不会冒充完整。

## 恢复
阅读AGENTS.md、spec.md、plan.md、acceptance.md和implementation.md。npm test / npm run typecheck / npm run build / npm run test:ui。不得改模型预算，不提交私人资料或artifacts。后续任务为可配置多主题雷达，单独维护任务文档。
