import {db} from '../db';
db.exec(`
CREATE TABLE IF NOT EXISTS observation_themes(id TEXT NOT NULL,version INTEGER NOT NULL,name TEXT NOT NULL,body TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(id,version));
CREATE TABLE IF NOT EXISTS observation_theme_states(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,object_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(task_id,object_id));
CREATE TABLE IF NOT EXISTS observation_templates(version TEXT PRIMARY KEY,body TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS observation_tasks(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,config_version INTEGER NOT NULL DEFAULT 1,epoch INTEGER NOT NULL DEFAULT 1,started_at TEXT,ends_at TEXT,next_at TEXT,last_success_at TEXT,last_check_at TEXT,baseline_key TEXT,failure_streak INTEGER NOT NULL DEFAULT 0,fault_notified_at TEXT,health TEXT NOT NULL DEFAULT '尚未检查');
CREATE TABLE IF NOT EXISTS observation_configs(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,version INTEGER NOT NULL,config TEXT NOT NULL,source_id TEXT REFERENCES records(id) ON DELETE SET NULL,created_at TEXT NOT NULL,PRIMARY KEY(task_id,version));
CREATE TABLE IF NOT EXISTS observation_cache(url TEXT PRIMARY KEY,body TEXT NOT NULL,received_at TEXT NOT NULL,expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS observation_frames(id TEXT PRIMARY KEY,observed_at TEXT NOT NULL,payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS observation_checks(run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,config_version INTEGER NOT NULL,epoch INTEGER NOT NULL,frame_id TEXT REFERENCES observation_frames(id),outcome TEXT NOT NULL DEFAULT 'queued',detail TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS observation_candidates(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,object_id TEXT NOT NULL,state TEXT NOT NULL,PRIMARY KEY(task_id,object_id));
CREATE TABLE IF NOT EXISTS observation_signals(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,dedupe_key TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS observation_actions(id TEXT PRIMARY KEY,task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,action TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL);
`);
