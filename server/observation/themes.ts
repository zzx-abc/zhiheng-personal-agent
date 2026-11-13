import {all,one,exec,now,transaction} from '../db';
import {themeSchema,type Theme,type ThemeRef} from './theme-types';
import seeds from './theme-seeds.json';
import './db';
export function ensureThemes(){for(const raw of seeds){const t=themeSchema.parse(raw);exec('INSERT OR IGNORE INTO observation_themes VALUES(?,?,?,?,?)',t.id,t.version,t.name,JSON.stringify(t),now());}}
export function themeCatalog(){ensureThemes();return all<{body:string}>(`SELECT body FROM observation_themes a WHERE version=(SELECT MAX(version) FROM observation_themes b WHERE b.id=a.id) ORDER BY rowid`).map(r=>themeSchema.parse(JSON.parse(r.body)));}
export function getTheme(ref:ThemeRef){ensureThemes();const r=one<{body:string}>('SELECT body FROM observation_themes WHERE id=? AND version=?',ref.id,ref.version);if(!r)throw Error('主题版本不存在：'+ref.id);return themeSchema.parse(JSON.parse(r.body));}
export function resolveThemes(refs:ThemeRef[]){if(new Set(refs.map(r=>r.id)).size!==refs.length)throw Error('主题不能重复');const themes=refs.map(getTheme);const identities=new Map<string,string>();for(const t of themes)for(const m of t.members){if(identities.has(m.symbol)&&identities.get(m.symbol)!==m.name)throw Error('不同主题对同一证券的名称不一致');identities.set(m.symbol,m.name);}return themes;}
export function saveTheme(raw:unknown,expectedVersion:number|null){const t=themeSchema.parse(raw);return transaction(()=>{ensureThemes();const old=one<{version:number}>('SELECT MAX(version) version FROM observation_themes WHERE id=?',t.id)?.version||null;if(old!==expectedVersion)throw Error('主题已更新，请重新读取再保存');t.version=(old||0)+1;t.effectiveAt=now();exec('INSERT INTO observation_themes VALUES(?,?,?,?,?)',t.id,t.version,t.name,JSON.stringify(t),now());return t;});}
export function defaultThemeRefs(){return themeCatalog().map(t=>({id:t.id,version:t.version}));}
