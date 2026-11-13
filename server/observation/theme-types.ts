import {z} from 'zod';
import {strategySchema} from './strategy-schema';
import type {Atom,Combination,ConditionStatus} from './conditions';
import type {EvaluationMode} from './mode';
import type {DecisionReport} from './strategy';
const date=z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const themeRefSchema=z.object({id:z.string().regex(/^[a-z0-9_-]{2,60}$/),version:z.number().int().positive()});
const source=z.object({url:z.string().url().refine(s=>s.startsWith('https://')),title:z.string().min(1).max(200),checkedAt:date,claim:z.string().min(2).max(800),type:z.enum(['disclosure','company','exchange','fund']),publishedAt:date.nullable().default(null)});
const member=z.object({symbol:z.string().regex(/^(sh(?:60|68)\d{4}|sz(?:00|30)\d{4})$/),name:z.string().min(2).max(30),aliases:z.array(z.string().max(30)).max(5).default([]),role:z.enum(['core','auxiliary','pending']),segments:z.array(z.string().min(1).max(30)).min(1).max(5),reason:z.string().min(2).max(500),sources:z.array(source).min(1).max(8),verified:z.boolean(),listing:z.object({status:z.enum(['listed','unverified']),date:date.nullable(),source:z.string().url()}),business:z.object({disclosed:z.string().max(800),products:z.string().max(500),commercial:z.string().max(500),contribution:z.string().max(500),inference:z.string().max(500),unknowns:z.array(z.string().max(200)).max(8)})});
export const themeSchema=z.object({
 id:themeRefSchema.shape.id,version:z.number().int().positive(),effectiveAt:z.string().datetime({offset:true}),name:z.string().min(2).max(60),scope:z.string().min(5).max(700),purpose:z.string().min(2).max(500),segments:z.array(z.string().min(1).max(30)).min(1).max(12),members:z.array(member).min(1).max(30),
 benchmarks:z.array(z.object({id:z.string().max(30),symbol:z.string().nullable().refine(s=>s===null||/^(sh000300|sz159516|sz159995)$/.test(s)),name:z.string().max(80),scope:z.string().max(400),source,role:z.enum(['market','theme','reference'])})).max(6),
 questions:z.array(z.string().max(200)).max(10),
 rules:z.object({version:z.literal('theme-rules/1.0'),enabled:z.array(z.enum(['relative','high','risk','price'])),relative3:z.number().min(0).max(30),relative5:z.number().min(0).max(30),highDays:z.number().int().min(5).max(40),confirmChecks:z.number().int().min(2).max(6),minCoverage:z.number().min(.5).max(1),breadth:z.number().min(.5).max(1),minLinked:z.number().int().min(2).max(10),requireVolume:z.boolean(),volumeRatio:z.number().min(1).max(5)}),
 priceLines:z.array(z.object({symbol:z.string(),direction:z.enum(['above','below']),price:z.number().positive(),sourceDate:date,basis:z.literal('unadjusted'),validUntil:date.nullable(),comparability:z.enum(['unverified','verified']),verification:z.string().max(500),verifiedThrough:date.nullable().default(null),enabled:z.boolean().optional(),reviewStatus:z.enum(['pending','verified','needs_review','disabled']).optional()})).max(50),
 strategy:strategySchema.optional(),
 notify:z.boolean().default(true)
}).superRefine((t,c)=>{
 if(new Set(t.members.map(m=>m.symbol)).size!==t.members.length)c.addIssue({code:'custom',message:'同主题证券不能重复；多个环节写入同一个成员'});
 for(const m of t.members)if(m.segments.some(s=>!t.segments.includes(s)))c.addIssue({code:'custom',message:'成员环节必须在主题范围内'});
 if(t.priceLines.some(p=>!t.members.some(m=>m.symbol===p.symbol)))c.addIssue({code:'custom',message:'价格条件对象不在主题中'});
 if(!t.benchmarks.some(b=>b.role==='market'&&b.symbol==='sh000300'))c.addIssue({code:'custom',message:'跨主题共同基准必须为沪深300'});
 if(t.priceLines.some(p=>p.comparability==='verified'&&(!p.verification||!p.verifiedThrough)))c.addIssue({code:'custom',message:'启用历史价位需要可比性依据和核验截止日'});
});
export type Theme=z.infer<typeof themeSchema>;
export type ThemeRef=z.infer<typeof themeRefSchema>;
export type ThemeMember=Theme['members'][number];
export type Condition={id:string;label:string;met:boolean|null;actual:number|null;threshold:number|null;basis:string;direction:'up'|'down';disabledReason?:string;status?:ConditionStatus;atoms?:Atom[];combination?:Combination;snapshot?:{status:ConditionStatus;actual:number|null;threshold:number;label:string};validation?:{status:string;reasons:string[];next:string}};
export type StockView={symbol:string;name:string;role:string;segments:string[];price:number|null;quoteAt:string|null;fresh:boolean;historyDays:number;return3:number|null;return5:number|null;relative3:number|null;relative5:number|null;intraday:number|null;intradayRelative:number|null;themeRelative3:number|null;themeRelative5:number|null;phase:string;historyStrong:boolean;strong:boolean;weak:boolean;conditions:Condition[];mode?:EvaluationMode;evidenceAt?:string|null;missing:string[];next:string;business:ThemeMember['business'];sources:ThemeMember['sources'];aliases:string[]};
export type ThemeView={id:string;name:string;version:number;scope:string;status:string;stocks:StockView[];configured:number;valid:number;pending:number;core:number;relative3:number|null;relative5:number|null;intradayRelative:number|null;strong:number;breadth:number;comparable:boolean;segments:{name:string;configured:number;valid:number;strong:number;relative3:number|null;relative5:number|null;status:string}[];missing:string[];change:string;next:string;benchmarks:Theme['benchmarks'];};
export type ThemeState={id:string;phase:string;status:string;candidate:string;checks:number;lastEvidence:string;episode:number;baseline:boolean;tradeDate:string;finalDates:string[];configVersion:number;evaluationVersion?:string};
export type ThemeEvent={id:string;conditionIds?:string[];objectId:string;themeIds:string[];names:string[];kind:string;phase:string;episode:number;change:string;evidence:string[];next:string;notify:boolean;};
export type ThemeReport={version:'theme-report/1';observedAt:string;phase:string;baseline:boolean;window:{start3:string|null;start5:string|null;end:string|null;basis:string};themes:ThemeView[];comparison:string;unique:{configured:number;valid:number;strong:number};events:ThemeEvent[];states:ThemeState[];limitations:string[];text:string;mode?:EvaluationMode;decision?:DecisionReport;};
