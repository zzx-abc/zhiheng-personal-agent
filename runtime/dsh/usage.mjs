/** Pure aggregation against DSH 0.2.2-rc.1 SessionEvent/TokenUsage schemas. */
export function summarizeDshUsage(events=[]) {
  let attempts=0, reportedAttempts=0;
  const totals={inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0,reasoningTokens:0};
  let model=null;
  for(const event of events) {
    if(!['assistant/message','assistant/attempt'].includes(event?.type)) continue;
    attempts++;
    const data=event.data||{};
    model=data.message?.source?.model??model;
    const streamed=(data.stream||[]).filter(r=>r.type==='chunk'&&r.chunk?.type==='usage').at(-1)?.chunk?.usage;
    const usage=data.usage??streamed;
    if(!usage||!Number.isFinite(usage.inputTokens)||!Number.isFinite(usage.outputTokens)) continue;
    reportedAttempts++;
    for(const key of Object.keys(totals)) if(Number.isFinite(usage[key])&&usage[key]>=0) totals[key]+=usage[key];
  }
  if(!reportedAttempts) return {usage:null,usageStatus:'unknown',attempts,reportedAttempts,model};
  // DSH inputTokens excludes cache. Aggregate prompt for OpenAI-style consumers:
  return {usage:{...totals,promptTokens:totals.inputTokens+totals.cacheReadTokens+totals.cacheWriteTokens,completionTokens:totals.outputTokens},usageStatus:attempts===reportedAttempts?'reported':'partial',attempts,reportedAttempts,model};
}
