// K3 supports reasoning_effort; the pinned pi-ai Moonshot detector predates
// this capability and otherwise omits it, leaving the provider at max effort.
export function modelPolicy(model) {
  return /^kimi-k3(?:$|[.-])/.test(model)
    ? {reasoningEffort:'low',modelYaml:'\n            reasoningEfforts:\n              low: low\n              high: high\n              max: max\n            compat:\n              supportsReasoningEffort: true\n              thinkingFormat: openai'}
    : {reasoningEffort:undefined,modelYaml:''};
}
