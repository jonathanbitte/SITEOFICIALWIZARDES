require('dotenv').config();

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const { pool, initializeDatabase } = require('./db');

const PROD = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_SENHA || '';

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('ERRO: configure JWT_SECRET com pelo menos 32 caracteres nas variáveis do Render.');
  process.exit(1);
}

const MAX_TENTATIVAS = 5;
const BLOQUEIO_MS = 15 * 60 * 1000;
const SESSAO_MS = 2 * 60 * 60 * 1000;
const HASH_FALSO = bcrypt.hashSync('WizardLoginInvalido2026', 10);
const ERRO_LOGIN = { erro: 'E-mail ou senha incorretos.' };
const COOKIE = {
  httpOnly: true,
  secure: PROD,
  sameSite: 'lax',
  path: '/',
};
const COOKIE_ADMIN = { ...COOKIE, maxAge: SESSAO_MS };
const COOKIE_USUARIO = { ...COOKIE, maxAge: SESSAO_MS };

const DEFAULT_ORIGINS = [
  'https://wizardes.com.br',
  'https://www.wizardes.com.br',
];
const ALLOWED_ORIGINS = new Set(
  (process.env.CORS_ORIGINS || DEFAULT_ORIGINS.join(','))
    .split(',')
    .map((origin) => origin.trim().replace(/\/$/, ''))
    .filter(Boolean)
);

const app = express();
if (PROD) app.set('trust proxy', 1);

function originPermitida(origin) {
  return !origin || ALLOWED_ORIGINS.has(origin.replace(/\/$/, ''));
}

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !originPermitida(origin)) {
    return res.status(403).json({ erro: 'Origem não autorizada.' });
  }

  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '600');
  }

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' })); // a Cielo avisa em formato de formulário
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

function exigeOrigemPermitida(req, res, next) {
  const origin = req.headers.origin;
  if (!origin || !originPermitida(origin)) {
    return res.status(403).json({ erro: 'Origem não autorizada para esta operação.' });
  }
  next();
}

async function exigeLogin(req, res, next) {
  let payload;
  try {
    payload = jwt.verify(req.cookies.sessao || '', JWT_SECRET);
  } catch {
    return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
  }

  if (!payload.sub || payload.tipo !== 'usuario') {
    return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
  }

  const [rows] = await pool.execute(
    'SELECT id, nome, email FROM responsaveis WHERE id = ? LIMIT 1',
    [payload.sub]
  );
  if (!rows.length) {
    return res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
  }

  req.usuario = rows[0];
  next();
}

function exigeAdmin(req, res, next) {
  try {
    const payload = jwt.verify(req.cookies.admin_sessao || '', JWT_SECRET);
    if (payload.tipo !== 'admin' || payload.sub !== ADMIN_USER) {
      throw new Error('sessão administrativa inválida');
    }
    req.admin = { usuario: ADMIN_USER };
    next();
  } catch {
    res.status(401).json({ erro: 'Autenticação administrativa necessária.' });
  }
}

function comparaSegredo(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

const limitaLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas. Aguarde alguns minutos.' },
});

const limitaCadastro = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitos cadastros deste dispositivo. Tente mais tarde.' },
});

const limitaAdmin = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas administrativas. Aguarde alguns minutos.' },
});

// Escolas e séries para as telas de acesso e cadastro.
app.get('/api/escolas', async (req, res) => {
  const [escolas] = await pool.execute(
    'SELECT id, slug, nome FROM escolas ORDER BY id'
  );
  const [series] = await pool.execute(
    'SELECT escola_id, nome FROM series ORDER BY id'
  );

  res.json(escolas.map((escola) => ({
    slug: escola.slug,
    nome: escola.nome,
    series: series
      .filter((serie) => String(serie.escola_id) === String(escola.id))
      .map((serie) => serie.nome),
  })));
});

app.post('/api/login', exigeOrigemPermitida, limitaLogin, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const senha = String(req.body?.senha || '');

  if (!email.includes('@') || !/^(?=.*[A-Za-z])(?=.*\d).{8,64}$/.test(senha)) {
    return res.status(400).json({
      erro: 'Informe o e-mail e uma senha com pelo menos 8 caracteres, usando letras e números.',
    });
  }

  const [rows] = await pool.execute(
    'SELECT id, nome, email, senha_hash, tentativas, bloqueado_ate FROM responsaveis WHERE email = ? LIMIT 1',
    [email]
  );
  const usuario = rows[0];

  if (!usuario) {
    await bcrypt.compare(senha, HASH_FALSO);
    return res.status(401).json(ERRO_LOGIN);
  }

  const agora = Date.now();
  const bloqueadoAte = Number(usuario.bloqueado_ate || 0);
  if (bloqueadoAte > agora) {
    const minutos = Math.ceil((bloqueadoAte - agora) / 60000);
    return res.status(429).json({
      erro: `Muitas tentativas erradas. Tente de novo em ${minutos} min.`,
    });
  }

  if (!(await bcrypt.compare(senha, usuario.senha_hash))) {
    const tentativas = Number(usuario.tentativas || 0) + 1;
    if (tentativas >= MAX_TENTATIVAS) {
      await pool.execute(
        'UPDATE responsaveis SET tentativas = 0, bloqueado_ate = ? WHERE id = ?',
        [agora + BLOQUEIO_MS, usuario.id]
      );
    } else {
      await pool.execute(
        'UPDATE responsaveis SET tentativas = ? WHERE id = ?',
        [tentativas, usuario.id]
      );
    }
    return res.status(401).json(ERRO_LOGIN);
  }

  await pool.execute(
    'UPDATE responsaveis SET tentativas = 0, bloqueado_ate = 0 WHERE id = ?',
    [usuario.id]
  );

  const token = jwt.sign(
    { sub: String(usuario.id), tipo: 'usuario' },
    JWT_SECRET,
    { expiresIn: '2h' }
  );
  res.cookie('sessao', token, COOKIE_USUARIO);
  res.json({ ok: true, nome: usuario.nome });
});

// Cadastro de responsável e aluno em uma única transação MySQL.
function cpfValido(cpf) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const t of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(cpf[i]) * (t + 1 - i);
    if (((soma * 10) % 11) % 10 !== Number(cpf[t])) return false;
  }
  return true;
}

const senhaFraca = (senha) =>
  /^(\d)\1{3}$/.test(senha) ||
  '0123456789'.includes(senha) ||
  '9876543210'.includes(senha);

app.post('/api/cadastro', exigeOrigemPermitida, limitaCadastro, async (req, res) => {
  const body = req.body || {};
  const falha = (campo, erro) => res.status(400).json({ campo, erro });
  const limpa = (valor) => String(valor || '').trim().replace(/\s+/g, ' ');

  const nomeAluno = limpa(body.nomeAluno);
  const nomeResp = limpa(body.nomeResp);
  const email = limpa(body.email).toLowerCase();
  const cpf = String(body.cpf || '').replace(/\D/g, '');
  const celular = String(body.celular || '').replace(/\D/g, '');
  const senha = String(body.senha || '');

  const [escolas] = await pool.execute(
    'SELECT id FROM escolas WHERE slug = ? LIMIT 1',
    [String(body.escola || '')]
  );
  const escola = escolas[0];
  if (!escola) return falha('escola', 'Escola inválida. Volte e escolha a escola novamente.');

  const [series] = await pool.execute(
    'SELECT id FROM series WHERE escola_id = ? AND nome = ? LIMIT 1',
    [escola.id, String(body.serie || '')]
  );
  const serie = series[0];
  if (!serie) return falha('serie', 'Escolha o livro (série) do aluno.');

  if (nomeAluno.length < 3 || nomeAluno.length > 100) return falha('nomeAluno', 'Informe o nome completo do aluno.');
  if (nomeResp.length < 3 || nomeResp.length > 100) return falha('nomeResp', 'Informe o nome completo do responsável.');

  const nascimento = String(body.nascimento || '');
  const dataNascimento = new Date(`${nascimento}T00:00:00Z`);
  const idade = (Date.now() - dataNascimento.getTime()) / 31557600000;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nascimento) ||
      Number.isNaN(dataNascimento.getTime()) ||
      dataNascimento.toISOString().slice(0, 10) !== nascimento ||
      idade < 1 || idade > 30) {
    return falha('nascimento', 'Informe a data de nascimento do aluno.');
  }

  if (!cpfValido(cpf)) return falha('cpf', 'CPF inválido. Confira os números.');
  if (!/^\d{10,11}$/.test(celular)) return falha('celular', 'Informe o celular com DDD.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) return falha('email', 'Informe um e-mail válido.');
  if (!/^(?=.*[A-Za-z])(?=.*\d).{8,64}$/.test(senha)) return falha('senha', 'A senha deve ter pelo menos 8 caracteres, com letras e números.');
  if (senhaFraca(senha)) return falha('senha', 'Escolha uma senha menos óbvia (evite 1234 ou 1111).');
  if (body.aceite !== true) return falha('aceite', 'Aceite a Política de Privacidade para continuar.');

  const [existentes] = await pool.execute(
    'SELECT id FROM responsaveis WHERE email = ? LIMIT 1',
    [email]
  );
  if (existentes.length) {
    return res.status(409).json({
      campo: 'email',
      erro: 'Este e-mail já tem cadastro. Use “Já sou aluno” para entrar.',
    });
  }

  const hash = await bcrypt.hash(senha, 10);
  const conexao = await pool.getConnection();
  let responsavelId;

  try {
    await conexao.beginTransaction();
    const [resultado] = await conexao.execute(
      `INSERT INTO responsaveis
       (nome, email, cpf, celular, senha_hash, aceite_em)
       VALUES (?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
      [nomeResp, email, cpf, celular, hash]
    );
    responsavelId = resultado.insertId;

    await conexao.execute(
      `INSERT INTO alunos (responsavel_id, serie_id, nome, nascimento)
       VALUES (?, ?, ?, ?)`,
      [responsavelId, serie.id, nomeAluno, nascimento]
    );

    await conexao.commit();
  } catch (erro) {
    await conexao.rollback();
    if (erro && erro.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({
        campo: 'email',
        erro: 'Este e-mail já tem cadastro. Use “Já sou aluno” para entrar.',
      });
    }
    throw erro;
  } finally {
    conexao.release();
  }

  const token = jwt.sign(
    { sub: String(responsavelId), tipo: 'usuario' },
    JWT_SECRET,
    { expiresIn: '2h' }
  );
  res.cookie('sessao', token, COOKIE_USUARIO);
  res.status(201).json({ ok: true });
});

// Autenticação administrativa independente da sessão de responsável.
app.post('/api/admin/login', exigeOrigemPermitida, limitaAdmin, (req, res) => {
  if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 12) {
    return res.status(503).json({
      erro: 'A autenticação administrativa não está configurada no servidor.',
    });
  }

  const usuario = String(req.body?.usuario || '');
  const senha = String(req.body?.senha || '');
  if (!comparaSegredo(usuario, ADMIN_USER) || !comparaSegredo(senha, ADMIN_PASSWORD)) {
    return res.status(401).json({ erro: 'Usuário ou senha administrativa incorretos.' });
  }

  const token = jwt.sign(
    { sub: ADMIN_USER, tipo: 'admin' },
    JWT_SECRET,
    { expiresIn: '2h' }
  );
  res.cookie('admin_sessao', token, COOKIE_ADMIN);
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true });
});

app.post('/api/admin/logout', exigeOrigemPermitida, (req, res) => {
  res.clearCookie('admin_sessao', COOKIE);
  res.json({ ok: true });
});

// Pagamento: dados do pedido e link Cielo da escola do aluno.
const WHATSAPP_FINANCEIRO = String(process.env.WHATSAPP_FINANCEIRO || '5527999645606').replace(/\D/g, '');

app.get('/api/pagamento', exigeLogin, async (req, res) => {
  const [rows] = await pool.execute(
    `SELECT a.nome AS aluno, s.nome AS serie, e.nome AS escola,
            e.link_cartao, e.link_pix, a.pagamento_status, a.pago_em
     FROM alunos a
     JOIN series s ON s.id = a.serie_id
     JOIN escolas e ON e.id = s.escola_id
     WHERE a.responsavel_id = ?
     ORDER BY a.id DESC
     LIMIT 1`,
    [req.usuario.id]
  );

  if (!rows.length) {
    return res.status(404).json({ erro: 'Nenhum aluno cadastrado nesta conta.' });
  }
  res.set('Cache-Control', 'no-store');
  res.json({
    ...rows[0],
    pago: rows[0].pagamento_status === 'pago',
    email: req.usuario.email,
    whatsapp: WHATSAPP_FINANCEIRO,
  });
});

// Guarda qual forma o responsável escolheu (cartão ou PIX) ao clicar para pagar
app.post('/api/pagamento/forma', exigeOrigemPermitida, exigeLogin, async (req, res) => {
  const forma = req.body && req.body.forma;
  if (!['cartao', 'pix'].includes(forma)) {
    return res.status(400).json({ erro: 'Forma de pagamento inválida.' });
  }
  await pool.execute(
    'UPDATE alunos SET forma_pagamento = ? WHERE responsavel_id = ? ORDER BY id DESC LIMIT 1',
    [forma, req.usuario.id]
  );
  res.json({ ok: true });
});

async function buscarCadastros() {
  const [rows] = await pool.execute(
    `SELECT r.criado_em, e.nome AS escola, s.nome AS serie, a.nome AS aluno,
            a.nascimento, r.nome AS responsavel, r.email, r.celular,
            a.id, a.pagamento_status, a.pago_em, a.forma_pagamento
     FROM alunos a
     JOIN responsaveis r ON r.id = a.responsavel_id
     JOIN series s ON s.id = a.serie_id
     JOIN escolas e ON e.id = s.escola_id
     ORDER BY a.id`
  );
  return rows;
}

app.get('/admin/cadastros.json', exigeAdmin, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(await buscarCadastros());
});

app.post('/admin/cadastros/reset', exigeOrigemPermitida, exigeAdmin, async (req, res) => {
  const conexao = await pool.getConnection();
  try {
    await conexao.beginTransaction();
    await conexao.execute('DELETE FROM alunos');
    await conexao.execute('DELETE FROM responsaveis');
    await conexao.commit();
  } catch (erro) {
    await conexao.rollback();
    throw erro;
  } finally {
    conexao.release();
  }
  res.set('Cache-Control', 'no-store');
  res.json({ ok: true });
});

const statusPagamentoBR = (l) => (l.pagamento_status === 'pago' ? 'Pago' : 'Pendente');
const formaBR = (f) => ({ cartao: 'Cartão', pix: 'PIX' }[f] || '');

function escaparHtml(valor) {
  return String(valor ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function dataBR(valor, comHora = false) {
  if (!valor) return '';
  const data = new Date(String(valor).replace(' ', 'T') + (String(valor).includes('Z') ? '' : 'Z'));
  if (Number.isNaN(data.getTime())) return String(valor);
  const partes = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    ...(comHora ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).formatToParts(data).reduce((acc, parte) => {
    acc[parte.type] = parte.value;
    return acc;
  }, {});
  return `${partes.day}/${partes.month}/${partes.year}${comHora ? ` ${partes.hour}:${partes.minute}` : ''}`;
}

function nascimentoBR(valor) {
  const match = String(valor || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : '';
}

function celularBR(valor) {
  const numero = String(valor || '').replace(/\D/g, '');
  if (numero.length === 11) return `(${numero.slice(0, 2)}) ${numero.slice(2, 7)}-${numero.slice(7)}`;
  if (numero.length === 10) return `(${numero.slice(0, 2)}) ${numero.slice(2, 6)}-${numero.slice(6)}`;
  return numero;
}

function idadeBR(valor) {
  if (!valor) return '';
  const data = new Date(`${String(valor).slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(data.getTime())
    ? ''
    : Math.floor((Date.now() - data.getTime()) / 31557600000);
}

app.get('/admin/cadastros.xls', exigeAdmin, async (req, res) => {
  const linhas = await buscarCadastros();
  const headers = [
    'Data do cadastro', 'Escola', 'Livro (série)', 'Aluno',
    'Nascimento', 'Idade', 'Responsável', 'E-mail', 'Celular',
    'Pagamento', 'Pago em', 'Forma escolhida',
  ];
  const cells = (values, header = false) =>
    values.map((value) =>
      `<td class="${header ? 'cab' : 'texto'}">${escaparHtml(value)}</td>`
    ).join('');

  const rows = [
    `<tr>${cells(headers, true)}</tr>`,
    ...linhas.map((linha) => `<tr>${cells([
      dataBR(linha.criado_em, true),
      linha.escola,
      linha.serie,
      linha.aluno,
      nascimentoBR(linha.nascimento),
      idadeBR(linha.nascimento),
      linha.responsavel,
      linha.email,
      celularBR(linha.celular),
      statusPagamentoBR(linha),
      dataBR(linha.pago_em, true),
      formaBR(linha.forma_pagamento),
    ])}</tr>`),
  ];

  const planilha = `<!doctype html><html><head><meta charset="utf-8"><style>
    table{border-collapse:collapse;font-family:Arial,sans-serif;font-size:11pt}
    td{border:1px solid #d9d9d9;padding:6px 9px;white-space:nowrap}
    .cab{font-weight:bold;background:#eaf0f8;color:#112347}
    .texto{mso-number-format:"\\@"}
  </style></head><body><table>${rows.join('')}</table></body></html>`;

  res.set('Cache-Control', 'no-store');
  res.type('application/vnd.ms-excel; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="cadastros-wip.xls"');
  res.send(planilha);
});

app.get('/admin/cadastros.csv', exigeAdmin, async (req, res) => {
  const linhas = await buscarCadastros();
  const celula = (valor) => {
    let texto = String(valor ?? '');
    if (/^[=+\-@\t\r]/.test(texto)) texto = `'${texto}`;
    return `"${texto.replace(/"/g, '""')}"`;
  };

  const cabecalho = [
    'Data do cadastro', 'Escola', 'Livro (série)', 'Aluno',
    'Nascimento', 'Idade', 'Responsável', 'E-mail', 'Celular',
    'Pagamento', 'Pago em', 'Forma escolhida',
  ];
  const corpo = linhas.map((linha) => [
    dataBR(linha.criado_em, true),
    linha.escola,
    linha.serie,
    linha.aluno,
    nascimentoBR(linha.nascimento),
    idadeBR(linha.nascimento),
    linha.responsavel,
    linha.email,
    celularBR(linha.celular),
    statusPagamentoBR(linha),
    dataBR(linha.pago_em, true),
    formaBR(linha.forma_pagamento),
  ].map(celula).join(';'));

  res.set('Cache-Control', 'no-store');
  res.type('text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="cadastros-wip.csv"');
  res.send('\ufeff' + [cabecalho.map(celula).join(';'), ...corpo].join('\r\n'));
});

// ---------- Cielo: avisos automáticos de pagamento (webhook) ----------
// No painel da Cielo (E-commerce > Link de Pagamento > Configurações), cadastre:
//   URL de Notificação:        https://api.wizardes.com.br/api/cielo/SEU_TOKEN/notificacao
//   URL de Mudança de Status:  https://api.wizardes.com.br/api/cielo/SEU_TOKEN/status
// (SEU_TOKEN = CIELO_WEBHOOK_TOKEN, nas variáveis do Render). Tipo de notificação: POST.
const CIELO_TOKEN = process.env.CIELO_WEBHOOK_TOKEN || '';
const CIELO_PAGO = 2; // payment_status 2 = Pago, no Link de Pagamento da Cielo

function exigeCielo(req, res, next) {
  if (CIELO_TOKEN.length < 24 || !comparaSegredo(req.params.token, CIELO_TOKEN)) {
    return res.sendStatus(404);
  }
  next();
}

const texto = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);
const inteiro = (v) => {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};

// Liga uma compra paga ao aluno certo: primeiro pelo e-mail do comprador, depois pelo CPF
async function conciliar(checkoutOrder) {
  const [pgs] = await pool.execute(
    'SELECT id, email, cpf, status_code, teste, aluno_id FROM pagamentos_cielo WHERE checkout_order = ? LIMIT 1',
    [checkoutOrder]
  );
  const pg = pgs[0];
  if (!pg || pg.status_code !== CIELO_PAGO || pg.aluno_id || pg.teste) return;
  if (!pg.email && !pg.cpf) return; // ainda falta o aviso com os dados do comprador

  const base = `SELECT a.id FROM alunos a JOIN responsaveis r ON r.id = a.responsavel_id
                WHERE a.pagamento_status <> 'pago' AND `;
  let [alunos] = pg.email
    ? await pool.execute(base + 'r.email = ? ORDER BY a.id LIMIT 1', [pg.email])
    : [[]];
  if (!alunos.length && pg.cpf) {
    [alunos] = await pool.execute(
      base + "REPLACE(REPLACE(r.cpf, '.', ''), '-', '') = ? ORDER BY a.id LIMIT 1", [pg.cpf]
    );
  }
  if (!alunos.length) return;

  await pool.execute(
    "UPDATE alunos SET pagamento_status = 'pago', pago_em = UTC_TIMESTAMP(3) WHERE id = ?",
    [alunos[0].id]
  );
  await pool.execute('UPDATE pagamentos_cielo SET aluno_id = ? WHERE id = ?', [alunos[0].id, pg.id]);
}

// 1) Finalização: chega quando a pessoa clica em Finalizar na Cielo (traz e-mail e CPF)
app.post('/api/cielo/:token/notificacao', exigeCielo, async (req, res) => {
  const b = req.body || {};
  const checkout = texto(b.checkout_cielo_order_number, 64);
  if (!checkout) return res.sendStatus(200);
  const email = (texto(b.customer_email, 191) || '').toLowerCase() || null;
  const cpf = (texto(b.customer_identity, 20) || '').replace(/\D/g, '') || null;
  const resumo = JSON.stringify({
    metodo: b.payment_method_type ?? null,
    parcelas: b.payment_installments ?? null,
    criado: b.created_date ?? null,
  });
  await pool.execute(
    `INSERT INTO pagamentos_cielo
       (checkout_order, order_number, email, cpf, nome, valor_centavos, status_code, teste, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE email = VALUES(email), cpf = VALUES(cpf), nome = VALUES(nome),
       order_number = VALUES(order_number), valor_centavos = VALUES(valor_centavos), payload = VALUES(payload)`,
    [checkout, texto(b.order_number, 100), email, cpf, texto(b.customer_name, 190), inteiro(b.amount),
     inteiro(b.payment_status), String(b.test_transaction).toLowerCase() === 'true' ? 1 : 0, resumo]
  );
  await conciliar(checkout);
  res.sendStatus(200);
});

// 2) Mudança de status: chega quando o PIX é pago ou o cartão é aprovado/negado
app.post('/api/cielo/:token/status', exigeCielo, async (req, res) => {
  const b = req.body || {};
  const checkout = texto(b.checkout_cielo_order_number, 64);
  const status = inteiro(b.payment_status);
  if (!checkout || status == null) return res.sendStatus(200);
  await pool.execute(
    `INSERT INTO pagamentos_cielo (checkout_order, order_number, valor_centavos, status_code, teste)
     VALUES (?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE status_code = VALUES(status_code)`,
    [checkout, texto(b.order_number, 100), inteiro(b.amount), status,
     String(b.test_transaction).toLowerCase() === 'true' ? 1 : 0]
  );
  await conciliar(checkout);
  res.sendStatus(200);
});

// Confirmação manual no admin (quando o e-mail do pagamento for diferente do cadastro)
app.post('/admin/alunos/:id/pagamento', exigeOrigemPermitida, exigeAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ erro: 'Aluno inválido.' });
  const pago = req.body && req.body.pago === true;
  const [r] = await pool.execute(
    pago
      ? "UPDATE alunos SET pagamento_status = 'pago', pago_em = COALESCE(pago_em, UTC_TIMESTAMP(3)) WHERE id = ?"
      : "UPDATE alunos SET pagamento_status = 'pendente', pago_em = NULL WHERE id = ?",
    [id]
  );
  if (!r.affectedRows) return res.status(404).json({ erro: 'Aluno não encontrado.' });
  res.json({ ok: true });
});

app.post('/api/logout', exigeOrigemPermitida, (req, res) => {
  res.clearCookie('sessao', COOKIE);
  res.json({ ok: true });
});

app.get('/api/me', exigeLogin, (req, res) => res.json(req.usuario));

app.use((erro, req, res, next) => {
  console.error('Erro na requisição:', erro && (erro.stack || erro.message || erro));
  if (res.headersSent) return next(erro);
  res.status(500).json({ erro: 'Ocorreu um erro interno. Tente novamente.' });
});

const PORT = Number(process.env.PORT || 3000);

initializeDatabase()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`API Wizard iniciada na porta ${PORT}.`);
      console.log(`Origens CORS autorizadas: ${Array.from(ALLOWED_ORIGINS).join(', ')}`);
    });
  })
  .catch((erro) => {
    console.error('Não foi possível inicializar o MySQL.');
    console.error(`DB_HOST configurado: ${process.env.DB_HOST ? 'sim' : 'não'}`);
    console.error('Verifique host externo, porta, usuário, senha, permissões e Remote Database Access da UOL Host.');
    console.error(erro && (erro.code || erro.message || erro));
    process.exit(1);
  });