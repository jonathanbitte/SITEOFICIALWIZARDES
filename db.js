const mysql = require('mysql2/promise');

const required = ['DB_HOST', 'DB_NAME', 'DB_USER', 'DB_PASSWORD'];
for (const key of required) {
  if (!process.env[key]) {
    throw new Error(`Variável de ambiente obrigatória ausente: ${key}`);
  }
}

const port = Number(process.env.DB_PORT || 3306);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('DB_PORT inválida. Informe uma porta entre 1 e 65535.');
}


const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,

  ssl: {
    minVersion: 'TLSv1.2',
    rejectUnauthorized: true,
  },

  waitForConnections: true,
  connectionLimit: Number(process.env.DB_CONNECTION_LIMIT || 10),
  queueLimit: 0,
  connectTimeout: 15000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  timezone: 'Z',
  dateStrings: true,
  charset: 'utf8mb4',
  decimalNumbers: true,
  supportBigNumbers: true,
  bigNumberStrings: true,
});

async function ensureSchema(connection = pool) {
  await connection.execute(`
    CREATE TABLE IF NOT EXISTS escolas (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      slug VARCHAR(100) NOT NULL,
      nome VARCHAR(190) NOT NULL,
      preco_centavos INT NULL,
      cielo_link TEXT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uq_escolas_slug (slug)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS series (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      escola_id BIGINT UNSIGNED NOT NULL,
      nome VARCHAR(190) NOT NULL,
      PRIMARY KEY (id),
      KEY idx_series_escola_id (escola_id),
      CONSTRAINT fk_series_escolas
        FOREIGN KEY (escola_id) REFERENCES escolas(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS responsaveis (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      nome VARCHAR(190) NOT NULL,
      email VARCHAR(191) NOT NULL,
      cpf VARCHAR(20) NOT NULL,
      celular VARCHAR(30) NOT NULL,
      senha_hash VARCHAR(255) NOT NULL,
      tentativas INT NOT NULL DEFAULT 0,
      bloqueado_ate BIGINT NOT NULL DEFAULT 0,
      aceite_em DATETIME(3) NULL,
      criado_em DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      UNIQUE KEY uq_responsaveis_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await connection.execute(`
    CREATE TABLE IF NOT EXISTS alunos (
      id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      responsavel_id BIGINT UNSIGNED NOT NULL,
      serie_id BIGINT UNSIGNED NOT NULL,
      nome VARCHAR(190) NOT NULL,
      nascimento VARCHAR(10) NULL,
      criado_em DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      PRIMARY KEY (id),
      KEY idx_alunos_responsavel_id (responsavel_id),
      KEY idx_alunos_serie_id (serie_id),
      CONSTRAINT fk_alunos_responsaveis
        FOREIGN KEY (responsavel_id) REFERENCES responsaveis(id)
        ON UPDATE CASCADE ON DELETE RESTRICT,
      CONSTRAINT fk_alunos_series
        FOREIGN KEY (serie_id) REFERENCES series(id)
        ON UPDATE CASCADE ON DELETE RESTRICT
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

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

async function seedOfficialData(connection = pool) {
  const linksCielo = require('./links-cielo');

  for (const [slug, nome, listaSeries] of dadosEscolas) {
    const [rows] = await connection.execute(
      'SELECT id FROM escolas WHERE slug = ? LIMIT 1',
      [slug]
    );

    let escolaId;
    if (!rows.length) {
      const [insert] = await connection.execute(
        'INSERT INTO escolas (slug, nome) VALUES (?, ?)',
        [slug, nome]
      );
      escolaId = insert.insertId;
    } else {
      escolaId = rows[0].id;
      await connection.execute(
        'UPDATE escolas SET nome = ? WHERE id = ?',
        [nome, escolaId]
      );
    }

    const [alunosVinculados] = await connection.execute(
      `SELECT COUNT(*) AS total
       FROM alunos a
       INNER JOIN series s ON s.id = a.serie_id
       WHERE s.escola_id = ?`,
      [escolaId]
    );

    // Sem alunos vinculados, a lista de séries pode ser sincronizada com a lista oficial.
    // Com alunos vinculados, preservamos séries históricas e apenas acrescentamos as ausentes.
    if (Number(alunosVinculados[0].total) === 0) {
      await connection.execute('DELETE FROM series WHERE escola_id = ?', [escolaId]);
    }

    for (const nomeSerie of listaSeries) {
      const [serieExistente] = await connection.execute(
        'SELECT id FROM series WHERE escola_id = ? AND nome = ? LIMIT 1',
        [escolaId, nomeSerie]
      );
      if (!serieExistente.length) {
        await connection.execute(
          'INSERT INTO series (escola_id, nome) VALUES (?, ?)',
          [escolaId, nomeSerie]
        );
      }
    }

    const link = linksCielo[slug];
    if (typeof link === 'string' && /^https:\/\//i.test(link)) {
      await connection.execute(
        'UPDATE escolas SET cielo_link = ? WHERE id = ?',
        [link, escolaId]
      );
    }
  }
}

async function initializeDatabase() {
  const connection = await pool.getConnection();
  try {
    await connection.ping();
    await ensureSchema(connection);
    await seedOfficialData(connection);
  } finally {
    connection.release();
  }
}

module.exports = {
  pool,
  ensureSchema,
  seedOfficialData,
  initializeDatabase,
};
