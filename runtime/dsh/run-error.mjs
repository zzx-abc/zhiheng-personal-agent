/** Extract only terminal diagnostics, never model reasoning or request bodies. */
export function dshRunError(result, secret='') {
  const reason=result.events?.filter(e=>e.type==='turn/end').at(-1)?.data?.reason;
  let detail=reason?.error?.message || '';
  if(secret) detail=detail.split(secret).join('[已隐藏]');
  detail=detail.replace(/Bearer\s+\S+|sk-[A-Za-z0-9_-]+/gi,'[已隐藏]').slice(0,400);
  if(/tool executor is unavailable/i.test(detail)) return 'Harness 执行器未就绪，请更新运行配置后重试。';
  if(/401|invalid.*api.?key|authentication/i.test(detail)) return 'Kimi 身份验证失败，请在设置中检查 API Key。';
  if(/429|rate.?limit|insufficient.*(balance|quota)/i.test(detail)) return 'Kimi 额度或调用频率受限，请检查余额或稍后重试。';
  if(['length','max_tokens','max-tokens'].includes(result.finishReason)) return '模型输出达到长度上限，未提交不完整回答。请缩小问题后重试。';
  return `Harness 未完成模型请求（${result.finishReason||'无结束状态'}）${detail?'：'+detail:'，请重试；若持续失败，可在设置中切换直接 Kimi API 排查。'}`;
}
