import {z} from 'zod';
const group=z.object({operator:z.enum(['AND','OR']),conditions:z.array(z.string().min(1)).min(1),stage:z.enum(['intraday','formal_close','persistent_close'])});
export const strategySchema=z.object({
 id:z.string().min(1),version:z.number().int().positive(),enabled:z.boolean().default(false),validation:z.enum(['unvalidated','backtested','forward_tested']),validationEvidence:z.string().default(''),
 horizon:z.string().min(1),scenario:z.string().min(1),modes:z.array(z.enum(['intraday','after_close'])).min(1),
 entry:group.nullable(),cancel:group.nullable(),hold:group.nullable(),reduce:group.nullable(),exit:group.nullable(),
 positionConstraint:z.object({kind:z.literal('price_range'),minimum:z.number().positive().nullable(),maximum:z.number().positive().nullable(),basis:z.literal('unadjusted'),source:z.string().min(1),sourceDate:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),validUntil:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable()}).refine(p=>(p.minimum!==null||p.maximum!==null)&&(p.minimum===null||p.maximum===null||p.minimum<=p.maximum),'价格区间必须有边界且上下限有效').nullable(),riskBoundary:z.string().nullable(),
 volumeRole:z.enum(['required','auxiliary']),sectorRole:z.enum(['required','auxiliary']),riskRole:z.literal('required'),missingBehavior:z.literal('block_action'),
}).superRefine((s,c)=>{if(s.enabled&&(!s.entry||!s.cancel||!s.hold||!s.reduce||!s.exit||!s.riskBoundary))c.addIssue({code:'custom',message:'启用策略前补齐入场、取消、持有、减仓、退出及风险边界；不采用默认投资偏好'});if(s.validation!=='unvalidated'&&!s.validationEvidence)c.addIssue({code:'custom',message:'策略验证状态需要真实验证依据'});});
export type Strategy=z.infer<typeof strategySchema>;
export function strategyDraft():Strategy{return {id:'personal-strategy-draft',version:1,enabled:false,validation:'unvalidated',validationEvidence:'',horizon:'2—4周',scenario:'精选主题机会筛选；完整交易策略待定义',modes:['intraday','after_close'],entry:null,cancel:null,hold:null,reduce:null,exit:null,positionConstraint:null,riskBoundary:null,volumeRole:'auxiliary',sectorRole:'auxiliary',riskRole:'required',missingBehavior:'block_action'};}
