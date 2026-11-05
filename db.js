const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const db = new Database(path.join(__dirname, 'wizard.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS escolas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    nome TEXT NOT NULL,
    preco_centavos INTEGER,   -- valor do material (preencher depois)
    cielo_link TEXT           -- link de pagamento da Cielo dessa escola (preencher depois)
  );
  CREATE TABLE IF NOT EXISTS series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    escola_id INTEGER NOT NULL REFERENCES escolas(id),
    nome TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS responsaveis (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    cpf TEXT NOT NULL,
    celular TEXT NOT NULL,
    senha_hash TEXT NOT NULL,
    tentativas INTEGER NOT NULL DEFAULT 0,
    bloqueado_ate INTEGER NOT NULL DEFAULT 0,
    aceite_em TEXT,           -- quando aceitou a Política de Privacidade
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS alunos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    responsavel_id INTEGER NOT NULL REFERENCES responsaveis(id),
    serie_id INTEGER NOT NULL REFERENCES series(id),
    nome TEXT NOT NULL,
    nascimento TEXT,
    criado_em TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// bancos criados antes dessa coluna existir
if (!db.prepare("SELECT 1 FROM pragma_table_info('responsaveis') WHERE name = 'aceite_em'").get()) {
  db.exec('ALTER TABLE responsaveis ADD COLUMN aceite_em TEXT');
}

// Escolas e séries oficiais do material didático WIP.
// A lista abaixo é usada tanto na API do cadastro quanto no admin.html.
const dadosEscolas = [
  ['fundamental', 'Fundamental', [
    '1º ano - Grade 1',
    '2º ano - Grade 2',
    '3º ano - Grade 3',
    '4º ano - Grade 4',
    '5º ano - Grade 5',
  ]],
  ['cariacica', 'CEC', [
    'Grupo 1 - Kinder 1',
    'Grupo 2 - Kinder 2',
    'Grupo 3 - Kinder 3',
    '1º ano - Grade 1',
    '2º ano - Grade 2',
    '3º ano - Grade 3',
    '4º ano - Grade 4',
    '5º ano - Grade 5',
  ]],
  ['brilho-de-sol', 'Brilho de Sol', [
    'Grupo 1 - Kinder 1',
    'Grupo 2 - Kinder 2',
    'Grupo 3 - Kinder 3',
  ]],
  ['salve-rainha', 'Salve Rainha', [
    '1º ano - Grade 1',
    '2º ano - Grade 2',
    '3º ano - Grade 3',
    '4º ano - Grade 4',
    '5º ano - Grade 5',
    '6º ano - Wider World 1',
    '7º ano - Wider World 2',
    '8º ano - Wider World 3',
    '9º ano - Wider World 4',
  ]],
];

const addEscola = db.prepare('INSERT INTO escolas (slug, nome) VALUES (?, ?)');
const addSerie = db.prepare('INSERT INTO series (escola_id, nome) VALUES (?, ?)');
const replaceSeries = db.transaction(() => {
  for (const [slug, nome, lista] of dadosEscolas) {
    let escola = db.prepare('SELECT id FROM escolas WHERE slug = ?').get(slug);
    if (!escola) {
      escola = { id: addEscola.run(slug, nome).lastInsertRowid };
    } else {
      db.prepare('UPDATE escolas SET nome = ? WHERE id = ?').run(nome, escola.id);
      const vinculados = db.prepare(`
        SELECT COUNT(*) AS n FROM alunos a
        JOIN series s ON s.id = a.serie_id
        WHERE s.escola_id = ?
      `).get(escola.id).n;
      // Depois que houver alunos vinculados, não apagamos as séries para preservar o histórico.
      // A instalação atual está vazia e recebe a lista oficial abaixo.
      if (vinculados > 0) continue;
      db.prepare('DELETE FROM series WHERE escola_id = ?').run(escola.id);
    }
    lista.forEach((serie) => addSerie.run(escola.id, serie));
  }
});
replaceSeries();

// Conta de teste, só fora de produção: teste@wizard.com / 1234
if (process.env.NODE_ENV !== 'production' &&
    !db.prepare("SELECT 1 FROM responsaveis WHERE email = 'teste@wizard.com'").get()) {
  db.prepare('INSERT INTO responsaveis (nome, email, cpf, celular, senha_hash) VALUES (?, ?, ?, ?, ?)')
    .run('Responsável de Teste', 'teste@wizard.com', '000.000.000-00', '(27) 90000-0000', bcrypt.hashSync('1234', 10));
}

if (!db.prepare("SELECT 1 FROM pragma_table_info('alunos') WHERE name = 'nascimento'").get()) {
  db.exec('ALTER TABLE alunos ADD COLUMN nascimento TEXT');
}

// Links da Cielo: vêm do arquivo links-cielo.js e são gravados a cada início do servidor
const links = require('./links-cielo');
const setLink = db.prepare('UPDATE escolas SET cielo_link = ? WHERE slug = ?');
for (const [slug, url] of Object.entries(links)) {
  if (/^https:\/\//.test(url)) setLink.run(url, slug);
}

module.exports = db;