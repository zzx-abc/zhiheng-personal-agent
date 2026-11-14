import type {Condition, StockView, ThemeReport} from './theme-types';
import type {DecisionItem} from './strategy';

export const wantsRawEvidence = (question: string) => /原始证据|逐项明细|完整证据/.test(question);
export const wantsEvidence = (question: string) => /依据|证据|详情|明细|条件|第?\d+页/.test(question);

function relativeEvidence(condition: Condition | undefined) {
  if (!condition || condition.status === 'DISABLED') return '';
  const periods = (condition.atoms ?? []).filter(a =>
    ['relative3', 'relative5'].includes(a.id) && ['PASS', 'FAIL'].includes(a.status)
    && a.actual !== null && a.threshold !== null);
  if (!periods.length) return '';
  const values = periods.map(a => {
    const n = a.actual!;
    const comparison = n === 0 ? '持平' : (n > 0 ? '领先 ' : '落后 ') + Math.abs(n).toFixed(2) + ' 个百分点';
    return (a.id === 'relative3' ? '3 日' : '5 日') + comparison;
  });
  const threshold = new Set(periods.map(a => a.threshold)).size === 1
    ? '至少领先 ' + periods[0].threshold + ' 个百分点'
    : periods.map(a => (a.id === 'relative3' ? '3 日' : '5 日') + '至少领先 ' + a.threshold + ' 个百分点').join('、');
  const outcome = periods.every(a => a.status === 'PASS') ? '达到' : periods.every(a => a.status === 'FAIL') ? '未达到' : '仅部分达到';
  const end = periods[0].window.end;
  return (end ? '截至 ' + end.slice(5).replace('-', '/') + '，' : '') + '相对沪深300，' + values.join('、') + '。' + outcome + '筛选门槛（' + threshold + '）。';
}

function nextCheck(stock: StockView, line: Condition | undefined, item?: DecisionItem) {
  if (line) {
    const checks: string[] = [];
    if (stock.mode?.basisMode === 'after_close' && stock.phase !== '正式收盘确认') checks.push('正式收盘价是否仍在线下');
    if (line.validation?.status === 'pending') checks.push('这条观察线在当日是否仍适用');
    if (checks.length) return '下一步核对' + checks.join('，以及') + '。';
    return '要确认是否首次跌破，还需对照此前有效价格与当时的观察线。';
  }
  if (item?.actions[0]?.code === 'screen_only' && stock.historyStrong) return '下一步核对当前价格确认及入场条件，这两段历史表现只支持优先研究。';
  const missing = stock.missing?.[0];
  return missing ? '待核实项 · ' + missing : '';
}

export function briefEvidence(report: ThemeReport, question: string, page: number) {
  const items = [...(report.decision?.risks ?? []), ...(report.decision?.opportunities ?? []), ...(report.decision?.others ?? [])];
  const rank = new Map(items.map((item, index) => [item.key, index]));
  const all = report.themes.flatMap(theme => theme.stocks.map(stock => ({theme, stock, key: theme.id + '/' + stock.symbol})));
  const named = all.filter(({stock}) => [stock.name, stock.symbol, stock.symbol.slice(2), ...(stock.aliases ?? [])].some(n => n && question.includes(n)));
  const themes = all.filter(({theme}) => question.includes(theme.name));
  const candidates = named.length ? named : themes.length ? themes : all;
  const ordered = candidates.slice().sort((a, b) => (rank.get(a.key) ?? Infinity) - (rank.get(b.key) ?? Infinity));
  const target = ordered[page - 1];
  if (!target) return ordered.length ? '这份检查共有 ' + ordered.length + ' 个对象，可按股票名称查看。' : '原检查没有保存可用的个股证据。';
  const {stock, key} = target;
  const item = items.find(i => i.key === key);
  const line = stock.conditions.find(c => c.direction === 'down' && c.status !== 'DISABLED' && c.snapshot?.status === 'PASS' && c.snapshot.actual !== null);
  const relative = relativeEvidence(stock.conditions.find(c => c.id === 'relative'));
  const lines: string[] = [];
  if (line?.snapshot && line.snapshot.actual !== null) {
    const {actual, threshold} = line.snapshot;
    const relation = actual === threshold ? '等于' : '低于';
    lines.push(stock.name + '需要先核验风险。当时快照为 ' + actual.toFixed(2) + ' 元，' + relation + '观察线 ' + threshold.toFixed(2) + ' 元。');
  } else if (stock.historyStrong && relative) {
    lines.push(stock.name + '进入研究候选，依据是3 日和 5 日两个观察窗口的相对表现。');
  } else lines.push(stock.name + '的检查依据');
  if (relative) lines.push(relative);
  if (!relative && !line) {
    const saved = stock.conditions.find(c => c.status !== 'DISABLED' && typeof c.met === 'boolean');
    if (saved) lines.push(saved.label + (saved.met ? '已满足' : '未满足') + (saved.actual != null && saved.threshold != null ? '（实际 ' + saved.actual.toFixed(2) + ' / 阈值 ' + saved.threshold.toFixed(2) + '）' : '') + '。');
  }
  const next = nextCheck(stock, line, item);
  if (next) lines.push(next);
  for (const action of item?.actions ?? []) {
    if (['consider_entry','consider_reduce','consider_exit','hold_valid','defer_entry'].includes(action.code)) lines.push('若' + action.scenario + '，' + action.label.replace(/。$/, '') + '。');
  }
  lines.push('查来源可回复「原始证据 ' + stock.name + '」。');
  return lines.join('\n\n');
}
