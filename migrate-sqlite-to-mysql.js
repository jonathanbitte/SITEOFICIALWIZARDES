require('dotenv').config();

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const { pool, ensureSchema } = require('./db');

function mysqlDateTime(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  const date = new Date(text.includes('T') || text.endsWith('Z') ? text : `${text.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Data inválida encontrada no SQLite na migração: ${text}`);
  }
  return date.toISOString().slice(0, 23).replace('T', ' ');
}

function sqliteRows(database, table) {
  return database.prepare(`SELECT * FROM "${table}"`).all();
}

async function countRows(connection, table) {
  const [rows] = await connection.execute(`SELECT COUNT(*) AS total FROM \`${table}\``);
  return Number(rows[0].total);
}

async function insertRows(connection, table, rows, columns, dateColumns = []) {
  if (!rows.length) return;
  const columnSql = columns.map((column) => `\`${column}\``).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  const sql = `INSERT INTO \`${table}\` (${columnSql}) VALUES (${placeholders})`;

  for (const row of rows) {
    const values = columns.map((column) => {
      const value = row[column] === undefined ? null : row[column];
      return dateColumns.includes(column) ? mysqlDateTime(value) : value;
    });
    await connection.execute(sql, values);
  }
}

async function main() {
  const sqlitePath = path.resolve(process.argv[2] || path.join(__dirname, 'wizard.db'));
  if (!fs.existsSync(sqlitePath)) {
    throw new Error(`Não encontrei o arquivo SQLite: ${sqlitePath}`);
  }

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-sqlite-migration-'));
  const snapshotPath = path.join(tempDir, 'wizard-snapshot.db');
  let sqlite;

  try {
    // Cria um snapshot consistente sem apagar nem alterar o wizard.db original.
    sqlite = new Database(sqlitePath, { readonly: true, fileMustExist: true });
    await sqlite.backup(snapshotPath);
    sqlite.close();
    sqlite = null;

    const source = new Database(snapshotPath, { readonly: true, fileMustExist: true });
    const escolas = sqliteRows(source, 'escolas');
    const series = sqliteRows(source, 'series');
    const responsaveis = sqliteRows(source, 'responsaveis');
    const alunos = sqliteRows(source, 'alunos');
    source.close();

    console.log('Registros encontrados no SQLite:');
    console.log(`- escolas: ${escolas.length}`);
    console.log(`- series: ${series.length}`);
    console.log(`- responsaveis: ${responsaveis.length}`);
    console.log(`- alunos: ${alunos.length}`);
    console.log('Nenhum dado pessoal será exibido neste log.');

    const connection = await pool.getConnection();
    try {
      await connection.ping();
      await ensureSchema(connection);

      const existentesResponsaveis = await countRows(connection, 'responsaveis');
      const existentesAlunos = await countRows(connection, 'alunos');
      if (existentesResponsaveis > 0 || existentesAlunos > 0) {
        throw new Error(
          'O MySQL já contém responsáveis ou alunos. Migração interrompida para evitar duplicação ou sobrescrita.'
        );
      }

      await connection.beginTransaction();
      try {
        // O servidor pode ter criado apenas escolas/séries oficiais no primeiro início.
        // Como não há cadastros, substituímos essas tabelas pelos registros SQLite preservando IDs.
        await connection.execute('DELETE FROM series');
        await connection.execute('DELETE FROM escolas');

        await insertRows(
          connection,
          'escolas',
          escolas,
          ['id', 'slug', 'nome', 'preco_centavos', 'cielo_link']
        );
        await insertRows(
          connection,
          'series',
          series,
          ['id', 'escola_id', 'nome']
        );
        await insertRows(
          connection,
          'responsaveis',
          responsaveis,
          [
            'id', 'nome', 'email', 'cpf', 'celular', 'senha_hash',
            'tentativas', 'bloqueado_ate', 'aceite_em', 'criado_em',
          ],
          ['aceite_em', 'criado_em']
        );
        await insertRows(
          connection,
          'alunos',
          alunos,
          ['id', 'responsavel_id', 'serie_id', 'nome', 'nascimento', 'criado_em'],
          ['criado_em']
        );

        await connection.commit();
      } catch (erro) {
        await connection.rollback();
        throw erro;
      }

      const resumo = {};
      for (const table of ['escolas', 'series', 'responsaveis', 'alunos']) {
        resumo[table] = await countRows(connection, table);
      }

      if (
        resumo.escolas !== escolas.length ||
        resumo.series !== series.length ||
        resumo.responsaveis !== responsaveis.length ||
        resumo.alunos !== alunos.length
      ) {
        throw new Error('A conferência final encontrou diferenças nas quantidades de registros.');
      }

      console.log('Migração concluída. Quantidades conferidas no MySQL:');
      for (const [table, total] of Object.entries(resumo)) {
        console.log(`- ${table}: ${total}`);
      }
      console.log('O arquivo wizard.db original não foi removido nem modificado.');
    } finally {
      connection.release();
    }
  } finally {
    if (sqlite) sqlite.close();
    await pool.end();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

main().catch((erro) => {
  console.error('Migração não concluída:', erro && (erro.code || erro.message || erro));
  console.error('O banco SQLite original foi mantido. Corrija a causa antes de tentar novamente.');
  process.exitCode = 1;
});
