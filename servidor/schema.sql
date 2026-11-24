-- Recly — banco de dados das contas e turmas (Cloudflare D1).
-- Cole tudo no console do D1 e execute uma única vez.
CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, nick TEXT, created INTEGER, credits INTEGER DEFAULT 0, last_active TEXT, streak INTEGER DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS users_nick ON users (lower(nick));
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, uid TEXT NOT NULL, created INTEGER);
CREATE INDEX IF NOT EXISTS sessions_uid ON sessions (uid);
CREATE TABLE IF NOT EXISTS codes (email TEXT PRIMARY KEY, hash TEXT, exp INTEGER, tries INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS groups (id TEXT PRIMARY KEY, name TEXT NOT NULL, "desc" TEXT, emoji TEXT, private INTEGER DEFAULT 0, goal INTEGER, owner TEXT, code TEXT UNIQUE, created INTEGER);
CREATE TABLE IF NOT EXISTS members (gid TEXT NOT NULL, uid TEXT NOT NULL, joined INTEGER, warned INTEGER DEFAULT 0, PRIMARY KEY (gid, uid));
CREATE INDEX IF NOT EXISTS members_uid ON members (uid);
CREATE TABLE IF NOT EXISTS progress (uid TEXT NOT NULL, date TEXT NOT NULL, n INTEGER DEFAULT 0, ms INTEGER DEFAULT 0, PRIMARY KEY (uid, date));
CREATE TABLE IF NOT EXISTS removals (gid TEXT, uid TEXT, at INTEGER, seen INTEGER DEFAULT 0);
CREATE INDEX IF NOT EXISTS removals_uid ON removals (uid);
CREATE TABLE IF NOT EXISTS rl (k TEXT PRIMARY KEY, n INTEGER, reset INTEGER);
CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, email TEXT, status TEXT, at INTEGER);
CREATE TABLE IF NOT EXISTS pending_credits (email TEXT PRIMARY KEY, n INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS hooklog (at INTEGER, ev TEXT, pid TEXT, email TEXT, approved INTEGER, revoked INTEGER);

-- Turmas abertas (edite nomes, descrições e metas semanais à vontade)
INSERT OR IGNORE INTO groups (id, name, "desc", emoji, private, goal, owner, code, created) VALUES
 ('tjsp', 'Turma TJSP 2027', 'Escrevente e Oficial de Justiça do Tribunal de Justiça de SP', '⚖️', 0, 20000, NULL, NULL, 0),
 ('inss', 'Turma INSS', 'Técnico do Seguro Social', '🏛️', 0, 20000, NULL, NULL, 0),
 ('pmsp', 'Turma Soldado PM SP', 'Soldado da Polícia Militar do Estado de São Paulo', '🛡️', 0, 20000, NULL, NULL, 0);
