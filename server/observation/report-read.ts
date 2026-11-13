import type {Frame,ObservationConfig} from './types';
import type {ThemeReport} from './theme-types';
import {analyzeThemes} from './theme-engine';
/** Never mutates the archived report, task state, event ledger or notification outbox. */
export function interpretArchived(report:ThemeReport,frame:Frame|null,config:ObservationConfig|null){
 if(report.decision||!frame?.themeConfigs?.length||!config)return null;
 const interpreted=analyzeThemes(frame,config,[],true,null,true);
 interpreted.baseline=report.baseline;
 return {version:'conditions/2',notice:'依据保存的当时帧按新版条件语义只读解读；原始报告保留，不代表新增市场事件，也不回填首次穿越历史',themeReport:interpreted};
}
