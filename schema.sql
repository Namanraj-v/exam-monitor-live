CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,role TEXT CHECK(role IN ('student','proctor')),created_at DOUBLE PRECISION NOT NULL);
CREATE TABLE IF NOT EXISTS login_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id),expires_at DOUBLE PRECISION NOT NULL);
CREATE TABLE IF NOT EXISTS auth_counts(username TEXT PRIMARY KEY,started DOUBLE PRECISION,count INTEGER);
CREATE TABLE IF NOT EXISTS exam_settings(id INTEGER PRIMARY KEY CHECK(id=1),exam_title TEXT,duration_seconds INTEGER,access_code TEXT,sensitivity TEXT CHECK(sensitivity IN ('standard','sensitive')),negative_marking INTEGER NOT NULL DEFAULT 0,updated_at DOUBLE PRECISION);
CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY,position INTEGER,type TEXT CHECK(type IN ('mcq','subjective')),text TEXT,options_json TEXT,correct_option INTEGER,marks REAL DEFAULT 1,created_at DOUBLE PRECISION);
CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY,candidate_name TEXT,roll_no TEXT,exam_title TEXT,reference_photo_path TEXT,started_at DOUBLE PRECISION,ended_at DOUBLE PRECISION,status TEXT CHECK(status IN ('active','completed')),suspicion_score REAL DEFAULT 0,verdict TEXT DEFAULT 'Clean',owner_user_id TEXT REFERENCES users(id),question_snapshot_json TEXT,telemetry_json TEXT DEFAULT '{}',duration_seconds INTEGER,negative_marking INTEGER NOT NULL DEFAULT 0,UNIQUE(owner_user_id,exam_title));
CREATE TABLE IF NOT EXISTS events(id TEXT PRIMARY KEY,session_id TEXT REFERENCES sessions(id),timestamp DOUBLE PRECISION,modality TEXT CHECK(modality IN ('video','audio','browser')),event_type TEXT,severity TEXT CHECK(severity IN ('low','medium','high')),confidence REAL,details_json TEXT,snapshot_path TEXT);
CREATE INDEX IF NOT EXISTS events_time ON events(session_id,event_type,timestamp);
CREATE TABLE IF NOT EXISTS answers(id TEXT PRIMARY KEY,session_id TEXT REFERENCES sessions(id),question_id TEXT,question_type TEXT,answer_text TEXT,verification_json TEXT,UNIQUE(session_id,question_id));
CREATE TABLE IF NOT EXISTS fusion_reports(id TEXT PRIMARY KEY,session_id TEXT REFERENCES sessions(id),created_at DOUBLE PRECISION,suspicion_score REAL,verdict TEXT,narrative TEXT,corroborated_incidents_json TEXT,suppressed_false_positives_json TEXT,engine_used TEXT CHECK(engine_used IN ('gemini-fusion','openai-fusion','local-rule-engine')));
CREATE TABLE IF NOT EXISTS evidence_images(filename TEXT PRIMARY KEY,session_id TEXT REFERENCES sessions(id),content_type TEXT,data BLOB,created_at DOUBLE PRECISION);

CREATE TABLE IF NOT EXISTS proctor_login_limits(username TEXT PRIMARY KEY, failures TEXT NOT NULL, locked_until DOUBLE PRECISION NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_exam_roll ON sessions(exam_title,roll_no);

CREATE TABLE IF NOT EXISTS question_images(id TEXT PRIMARY KEY,content_type TEXT NOT NULL,data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS question_attachments(question_id TEXT PRIMARY KEY REFERENCES questions(id) ON DELETE CASCADE,image_id TEXT NOT NULL REFERENCES question_images(id));
