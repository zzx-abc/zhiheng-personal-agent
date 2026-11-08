import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
export const dataDir = process.env.AGENT_DATA_DIR || path.join(process.cwd(), 'data');
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
export const db = new DatabaseSync(path.join(dataDir, 'agent.sqlite'));
chmodSync(path.join(dataDir, 'agent.sqlite'), 0o600);
db.exec(`PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
INSERT OR IGNORE INTO meta VALUES('revision',0);
CREATE TABLE IF NOT EXISTS topics(id TEXT PRIMARY KEY,title TEXT NOT NULL,question TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS records(id TEXT PRIMARY KEY,topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,role TEXT NOT NULL,kind TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,run_id TEXT);
CREATE TABLE IF NOT EXISTS attachments(id TEXT PRIMARY KEY,record_id TEXT REFERENCES records(id) ON DELETE CASCADE,name TEXT NOT NULL,mime TEXT NOT NULL,bytes INTEGER NOT NULL,path TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,kind TEXT NOT NULL,content TEXT NOT NULL,status TEXT NOT NULL,source_id TEXT REFERENCES records(id) ON DELETE CASCADE,source_quote TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,previous_id TEXT);
CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY,topic_id TEXT REFERENCES topics(id) ON DELETE CASCADE,title TEXT NOT NULL,question TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'active',trigger TEXT NOT NULL DEFAULT 'manual',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_run_id TEXT);
CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,record_id TEXT REFERENCES records(id) ON DELETE CASCADE,topic_id TEXT REFERENCES topics(id) ON DELETE SET NULL,mode TEXT NOT NULL,status TEXT NOT NULL,phase TEXT NOT NULL DEFAULT 'waiting',revision INTEGER NOT NULL,created_at TEXT NOT NULL,started_at TEXT,finished_at TEXT,heartbeat TEXT,error TEXT,result TEXT,usage INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS single_task_run ON runs(task_id) WHERE status IN ('queued','running');
CREATE TABLE IF NOT EXISTS evidence(id TEXT PRIMARY KEY,run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,title TEXT NOT NULL,url TEXT NOT NULL,body TEXT NOT NULL,published_at TEXT,retrieved_at TEXT NOT NULL,level TEXT NOT NULL,hash TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reports(id TEXT PRIMARY KEY,run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,agent TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(run_id,agent));
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,type TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage(id TEXT PRIMARY KEY,run_id TEXT,model TEXT NOT NULL,tokens INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS working_states(id TEXT PRIMARY KEY,topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,status TEXT NOT NULL,content TEXT NOT NULL,created_at TEXT NOT NULL,previous_id TEXT);
CREATE UNIQUE INDEX IF NOT EXISTS one_current_state ON working_states(topic_id) WHERE status='current';
CREATE INDEX IF NOT EXISTS records_topic ON records(topic_id,created_at);
CREATE INDEX IF NOT EXISTS runs_status ON runs(status,created_at);`);
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function all<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T[] { return db.prepare(sql).all(...params) as T[]; }
export function one<T = Record<string, unknown>>(sql: string, ...params: (string | number | null)[]): T | undefined { return db.prepare(sql).get(...params) as T | undefined; }
export function exec(sql: string, ...params: (string | number | null)[]) { return db.prepare(sql).run(...params); }
export function transaction<T>(fn: () => T): T { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } }
export const revision = () => Number(one<{value:number}>("SELECT value FROM meta WHERE key='revision'")!.value);
export const bump = () => exec("UPDATE meta SET value=value+1 WHERE key='revision'");
export function event(runId: string, type: string, detail: unknown) { exec('INSERT INTO events VALUES(?,?,?,?,?)', id(), runId, type, JSON.stringify(detail), now()); }
export type Topic = {id:string;title:string;question:string;status:string;created_at:string;updated_at:string};
export type RecordRow = {id:string;topic_id:string|null;role:string;kind:string;content:string;created_at:string;run_id:string|null};
export type Memory = {id:string;topic_id:string|null;kind:string;content:string;status:string;source_id:string;source_quote:string;created_at:string;updated_at:string};
export type Run = {id:string;task_id:string|null;record_id:string;topic_id:string|null;mode:string;status:string;phase:string;revision:number;created_at:string;started_at:string;error:string|null;result:string|null};
export type Evidence = {id:string;run_id:string;title:string;url:string;body:string;published_at:string|null;retrieved_at:string;level:string};
