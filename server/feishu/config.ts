import {existsSync,readFileSync,writeFileSync,renameSync,chmodSync} from 'node:fs';
import path from 'node:path';
import {z} from 'zod';
import {dataDir,db,exec,all,one,now} from '../db';
import '../library/db';
const file=path.join(dataDir,'feishu-app-credentials.json');
export const connectionSchema=z.object({appId:z.string().regex(/^cli_[A-Za-z0-9]+$/),appSecret:z.string().min(10).max(300),allowedUsers:z.array(z.string().regex(/^ou_[A-Za-z0-9_-]+$/)).min(1).max(10),allowedChats:z.array(z.string().regex(/^oc_[A-Za-z0-9_-]+$/)).max(10).default([]),enabled:z.boolean().default(false),collectionMode:z.boolean().default(false),generation:z.number().int().default(1)});
export type Connection=z.infer<typeof connectionSchema>;
db.exec(`CREATE TABLE IF NOT EXISTS feishu_inbox(id TEXT PRIMARY KEY,message_id TEXT UNIQUE NOT NULL,sender TEXT NOT NULL,chat TEXT NOT NULL,parent TEXT,type TEXT NOT NULL,content TEXT NOT NULL,run_id TEXT UNIQUE REFERENCES runs(id) ON DELETE CASCADE,generation INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS feishu_replies(message_id TEXT PRIMARY KEY,chat TEXT NOT NULL,entries TEXT NOT NULL,run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS feishu_runtime(id INTEGER PRIMARY KEY CHECK(id=1),state TEXT NOT NULL,heartbeat TEXT NOT NULL);`);
// v0.11: platform message IDs are scoped in feishu_scopes; old rows remain intact.
if((one<{sql:string}>("SELECT sql FROM sqlite_master WHERE name='feishu_inbox'")?.sql||'').includes('message_id TEXT UNIQUE'))db.exec(`BEGIN IMMEDIATE;
CREATE TABLE feishu_inbox_v11(id TEXT PRIMARY KEY,message_id TEXT NOT NULL,sender TEXT NOT NULL,chat TEXT NOT NULL,parent TEXT,type TEXT NOT NULL,content TEXT NOT NULL,run_id TEXT UNIQUE REFERENCES runs(id) ON DELETE CASCADE,generation INTEGER NOT NULL,created_at TEXT NOT NULL);
INSERT INTO feishu_inbox_v11 SELECT * FROM feishu_inbox;
DROP TABLE feishu_inbox;
ALTER TABLE feishu_inbox_v11 RENAME TO feishu_inbox;
CREATE INDEX feishu_inbox_message ON feishu_inbox(message_id,chat);
COMMIT;`);
export function connection():Connection|null{try{return existsSync(file)?connectionSchema.parse(JSON.parse(readFileSync(file,'utf8'))):null}catch{return null}}
export function connectionStatus(){const c=connection(),runtime=one<{state:string;heartbeat:string}>('SELECT * FROM feishu_runtime WHERE id=1');return {configured:!!c,appId:c?.appId||'',enabled:c?.enabled||false,allowedUsers:c?.allowedUsers||[],allowedChats:c?.allowedChats||[],collectionMode:c?.collectionMode||false,state:runtime&&Date.now()-Date.parse(runtime.heartbeat)<20000?runtime.state:'未连接',secretSaved:!!c?.appSecret};}
export function saveConnection(raw:unknown){const incoming=z.object({appId:z.string(),appSecret:z.string().optional(),allowedUsers:z.array(z.string()),allowedChats:z.array(z.string()).default([]),enabled:z.boolean(),collectionMode:z.boolean()}).parse(raw);const previous=connection();const c=connectionSchema.parse({...incoming,appSecret:incoming.appSecret||previous?.appSecret,generation:(previous?.generation||0)+1});const tmp=file+'.tmp';writeFileSync(tmp,JSON.stringify(c),{mode:0o600});chmodSync(tmp,0o600);renameSync(tmp,file);exec("UPDATE notification_outbox SET status='cancelled',error='飞书应用连接配置已改变',updated_at=? WHERE kind='library_feishu' AND status='queued'",now());return connectionStatus();}
export function authorized(c:Connection,sender:string,chat:string){return c.enabled&&c.allowedUsers.includes(sender)&&(!c.allowedChats.length||c.allowedChats.includes(chat));}
export function scrubFeishuEntry(key:string){for(const r of all<{message_id:string;entries:string}>('SELECT message_id,entries FROM feishu_replies'))if(JSON.parse(r.entries).includes(key))exec('DELETE FROM feishu_replies WHERE message_id=?',r.message_id);}
