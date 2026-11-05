require('dotenv').config();
const path = require('path');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const db = require('./db');

const PROD = process.env.NODE_ENV === 'production';
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('Defina JWT_SECRET (32+ caracteres) no arquivo .env');
  process.exit(1);
}

const MAX_TENTATIVAS = 5;              // erros seguidos antes de bloquear a conta
const BLOQUEIO_MS = 15 * 60 * 1000;    // 15 minutos
const SESSAO_MS = 2 * 60 * 60 * 1000;  // 2 horas
const HASH_FALSO = bcrypt.hashSync('0000', 10); // evita revelar se o e-mail existe pelo tempo de resposta
const ERRO_LOGIN = { erro: 'E-mail ou senha incorretos.' };
// Em produção o site é servido em HTTPS e pode ser embutido pelo Preview.
// SameSite=None é necessário para que a sessão acompanhe requisições cross-site.
const COOKIE = PROD
  ? { httpOnly: true, sameSite: 'none', secure: true }
  : { httpOnly: true, sameSite: 'lax', secure: false };

const app = express();
if (PROD) app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

function exigeLogin(req, res, next) {
  try {
    const { sub } = jwt.verify(req.cookies.sessao || '', JWT_SECRET);
    const usuario = db.prepare('SELECT id, nome, email FROM responsaveis WHERE id = ?').get(sub);
    if (!usuario) throw new Error('usuário não existe');
    req.usuario = usuario;
    next();
  } catch {
    res.status(401).json({ erro: 'Sessão expirada. Faça login novamente.' });
  }
}

// Escolas e séries para a tela de acesso e para o cadastro
app.get('/api/escolas', (req, res) => {
  const escolas = db.prepare('SELECT id, slug, nome FROM escolas ORDER BY id').all();
  const series = db.prepare('SELECT escola_id, nome FROM series ORDER BY id').all();
  res.json(escolas.map((e) => ({
    slug: e.slug,
    nome: e.nome,
    series: series.filter((s) => s.escola_id === e.id).map((s) => s.nome),
  })));
});

const limitaLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitas tentativas. Aguarde alguns minutos.' },
});

app.post('/api/login', limitaLogin, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const senha = String(req.body?.senha || '');
  if (!email.includes('@') || !/^(?=.*[A-Za-z])(?=.*\d).{8,64}$/.test(senha)) {
    return res.status(400).json({ erro: 'Informe o e-mail e uma senha com pelo menos 8 caracteres, usando letras e números.' });
  }

  const u = db.prepare('SELECT * FROM responsaveis WHERE email = ?').get(email);
  if (!u) {
    await bcrypt.compare(senha, HASH_FALSO);
    return res.status(401).json(ERRO_LOGIN);
  }

  const agora = Date.now();
  if (u.bloqueado_ate > agora) {
    const min = Math.ceil((u.bloqueado_ate - agora) / 60000);
    return res.status(429).json({ erro: `Muitas tentativas erradas. Tente de novo em ${min} min.` });
  }

  if (!(await bcrypt.compare(senha, u.senha_hash))) {
    const tentativas = u.tentativas + 1;
    if (tentativas >= MAX_TENTATIVAS) {
      db.prepare('UPDATE responsaveis SET tentativas = 0, bloqueado_ate = ? WHERE id = ?').run(agora + BLOQUEIO_MS, u.id);
    } else {
      db.prepare('UPDATE responsaveis SET tentativas = ? WHERE id = ?').run(tentativas, u.id);
    }
    return res.status(401).json(ERRO_LOGIN);
  }

  db.prepare('UPDATE responsaveis SET tentativas = 0, bloqueado_ate = 0 WHERE id = ?').run(u.id);
  const token = jwt.sign({ sub: u.id }, JWT_SECRET, { expiresIn: '2h' });
  res.cookie('sessao', token, { ...COOKIE, maxAge: SESSAO_MS });
  res.json({ ok: true, nome: u.nome });
});

// ---------- Cadastro (primeiro acesso) ----------
const limitaCadastro = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { erro: 'Muitos cadastros deste dispositivo. Tente mais tarde.' },
});

function cpfValido(cpf) {
  if (!/^\d{11}$/.test(cpf) || /^(\d)\1{10}$/.test(cpf)) return false;
  for (const t of [9, 10]) {
    let soma = 0;
    for (let i = 0; i < t; i++) soma += Number(cpf[i]) * (t + 1 - i);
    if (((soma * 10) % 11) % 10 !== Number(cpf[t])) return false;
  }
  return true;
}

// 4 números têm só 10 mil combinações: bloqueia as mais óbvias (1111, 1234, 4321...)
const senhaFraca = (s) => /^(\d)\1{3}$/.test(s) || '0123456789'.includes(s) || '9876543210'.includes(s);

app.post('/api/cadastro', limitaCadastro, async (req, res) => {
  const b = req.body || {};
  const falha = (campo, erro) => res.status(400).json({ campo, erro });
  const limpa = (v) => String(v || '').trim().replace(/\s+/g, ' ');
  const nomeAluno = limpa(b.nomeAluno);
  const nomeResp = limpa(b.nomeResp);
  const email = limpa(b.email).toLowerCase();
  const cpf = String(b.cpf || '').replace(/\D/g, '');
  const celular = String(b.celular || '').replace(/\D/g, '');
  const senha = String(b.senha || '');

  const escola = db.prepare('SELECT id FROM escolas WHERE slug = ?').get(String(b.escola || ''));
  if (!escola) return falha('escola', 'Escola inválida. Volte e escolha a escola novamente.');
  const serie = db.prepare('SELECT id FROM series WHERE escola_id = ? AND nome = ?').get(escola.id, String(b.serie || ''));
  if (!serie) return falha('serie', 'Escolha o livro (série) do aluno.');
  if (nomeAluno.length < 3 || nomeAluno.length > 100) return falha('nomeAluno', 'Informe o nome completo do aluno.');
  if (nomeResp.length < 3 || nomeResp.length > 100) return falha('nomeResp', 'Informe o nome completo do responsável.');
  const nasc = String(b.nascimento || '');
  const dn = new Date(nasc + 'T00:00:00Z');
  const anos = (Date.now() - dn) / 31557600000;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(nasc) || isNaN(dn) || anos < 1 || anos > 30) {
    return falha('nascimento', 'Informe a data de nascimento do aluno.');
  }
  if (!cpfValido(cpf)) return falha('cpf', 'CPF inválido. Confira os números.');
  if (!/^\d{10,11}$/.test(celular)) return falha('celular', 'Informe o celular com DDD.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) return falha('email', 'Informe um e-mail válido.');
  if (!/^(?=.*[A-Za-z])(?=.*\d).{8,64}$/.test(senha)) return falha('senha', 'A senha deve ter pelo menos 8 caracteres, com letras e números.');
  if (senhaFraca(senha)) return falha('senha', 'Escolha uma senha menos óbvia (evite 1234 ou 1111).');
  if (b.aceite !== true) return falha('aceite', 'Aceite a Política de Privacidade para continuar.');

  if (db.prepare('SELECT 1 FROM responsaveis WHERE email = ?').get(email)) {
    return res.status(409).json({ campo: 'email', erro: 'Este e-mail já tem cadastro. Use “Já sou aluno” para entrar.' });
  }

  const hash = await bcrypt.hash(senha, 10);
  const id = db.transaction(() => {
    const r = db.prepare(
      'INSERT INTO responsaveis (nome, email, cpf, celular, senha_hash, aceite_em) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(nomeResp, email, cpf, celular, hash, new Date().toISOString());
    db.prepare('INSERT INTO alunos (responsavel_id, serie_id, nome, nascimento) VALUES (?, ?, ?, ?)').run(r.lastInsertRowid, serie.id, nomeAluno, nasc);
    return r.lastInsertRowid;
  })();

  const token = jwt.sign({ sub: id }, JWT_SECRET, { expiresIn: '2h' });
  res.cookie('sessao', token, { ...COOKIE, maxAge: SESSAO_MS });
  res.status(201).json({ ok: true });
});

// ---------- Pagamento: dados do pedido e link da Cielo da escola do aluno ----------
app.get('/api/pagamento', exigeLogin, (req, res) => {
  const p = db.prepare(`
    SELECT a.nome AS aluno, s.nome AS serie, e.nome AS escola, e.cielo_link AS link
    FROM alunos a JOIN series s ON s.id = a.serie_id JOIN escolas e ON e.id = s.escola_id
    WHERE a.responsavel_id = ? ORDER BY a.id DESC LIMIT 1`).get(req.usuario.id);
  if (!p) return res.status(404).json({ erro: 'Nenhum aluno cadastrado nesta conta.' });
  res.json(p);
});

// ---------- Lista/planilha de cadastros (área administrativa) ----------
function buscarCadastros() {
  return db.prepare(`
    SELECT r.criado_em, e.nome AS escola, s.nome AS serie, a.nome AS aluno, a.nascimento,
           r.nome AS responsavel, r.email, r.celular
    FROM alunos a JOIN responsaveis r ON r.id = a.responsavel_id
    JOIN series s ON s.id = a.serie_id JOIN escolas e ON e.id = s.escola_id
    ORDER BY a.id`).all();
}
app.get('/admin/cadastros.json', limitaLogin, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(buscarCadastros());
});
app.post('/admin/cadastros/reset', limitaLogin, (req, res) => {
  db.transaction(() => {
    db.prepare('DELETE FROM alunos').run();
    db.prepare('DELETE FROM responsaveis').run();
  })();
  res.json({ ok: true });
});

app.get('/admin/cadastros.xls', limitaLogin, (req, res) => {
  const esc = (v) => String(v ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const dataBR = (valor, comHora = false) => {
    if (!valor) return '';
    const data = new Date(String(valor).replace(' ', 'T') + (String(valor).includes('Z') ? '' : 'Z'));
    if (Number.isNaN(data.getTime())) return String(valor);
    const p = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
      ...(comHora ? { hour: '2-digit', minute: '2-digit' } : {})
    }).formatToParts(data).reduce((a, x) => (a[x.type] = x.value, a), {});
    return `${p.day}/${p.month}/${p.year}${comHora ? ` ${p.hour}:${p.minute}` : ''}`;
  };
  const nascimentoBR = (valor) => {
    const m = String(valor || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : '';
  };
  const celularBR = (valor) => {
    const n = String(valor || '').replace(/\D/g, '');
    if (n.length === 11) return `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
    if (n.length === 10) return `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
    return n;
  };
  const linhas = buscarCadastros();
  const headers = ['Data do cadastro', 'Escola', 'Livro (série)', 'Aluno', 'Nascimento', 'Idade', 'Responsável', 'E-mail', 'Celular'];
  const cells = (vals, header = false) => vals.map((v) => `<td class="${header ? 'cab' : 'texto'}">${esc(v)}</td>`).join('');
  const rows = [
    `<tr>${cells(headers, true)}</tr>`,
    ...linhas.map((l) => {
      const idade = l.nascimento ? Math.floor((Date.now() - new Date(l.nascimento + 'T00:00:00Z')) / 31557600000) : '';
      return `<tr>${cells([dataBR(l.criado_em, true), l.escola, l.serie, l.aluno, nascimentoBR(l.nascimento), idade, l.responsavel, l.email, celularBR(l.celular)])}</tr>`;
    })
  ];
  const planilha = `<!doctype html><html><head><meta charset="utf-8"><style>
    table{border-collapse:collapse;font-family:Arial,sans-serif;font-size:11pt}
    td{border:1px solid #d9d9d9;padding:6px 9px;white-space:nowrap}
    .cab{font-weight:bold;background:#eaf0f8;color:#112347}
    .texto{mso-number-format:"\\@"}
  </style></head><body><table>${rows.join('')}</table></body></html>`;
  res.type('application/vnd.ms-excel; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="cadastros-wip.xls"');
  res.send(planilha);
});

app.get('/admin/cadastros.csv', limitaLogin, (req, res) => {
  const linhas = buscarCadastros();
  const cel = (v) => {
    let t = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; // evita fórmula maliciosa no Excel
    return '"' + t.replace(/"/g, '""') + '"';
  };
  const dataBR = (valor, comHora = false) => {
    if (!valor) return '';
    const data = new Date(String(valor).replace(' ', 'T') + (String(valor).includes('Z') ? '' : 'Z'));
    if (Number.isNaN(data.getTime())) return String(valor);
    const partes = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
      ...(comHora ? { hour: '2-digit', minute: '2-digit' } : {})
    }).formatToParts(data).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
    return `${partes.day}/${partes.month}/${partes.year}${comHora ? ` ${partes.hour}:${partes.minute}` : ''}`;
  };
  const dataNascimentoBR = (valor) => {
    const m = String(valor || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `'${m[3]}/${m[2]}/${m[1]}` : '';
  };
  const celularExcel = (valor) => {
    const n = String(valor || '').replace(/\D/g, '');
    if (n.length === 11) return `'(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`;
    if (n.length === 10) return `'(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`;
    return n ? `'${n}` : '';
  };
  const cab = ['Data do cadastro', 'Escola', 'Livro (série)', 'Aluno', 'Nascimento', 'Idade', 'Responsável', 'E-mail', 'Celular'];
  const corpo = linhas.map((l) => {
    const idade = l.nascimento ? Math.floor((Date.now() - new Date(l.nascimento + 'T00:00:00Z')) / 31557600000) : '';
    return [dataBR(l.criado_em, true), l.escola, l.serie, l.aluno, dataNascimentoBR(l.nascimento), idade, l.responsavel, l.email, celularExcel(l.celular)].map(cel).join(';');
  });
  res.type('text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="cadastros-wip.csv"');
  res.send('\ufeff' + [cab.map(cel).join(';'), ...corpo].join('\r\n'));
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('sessao', COOKIE);
  res.json({ ok: true });
});

app.get('/api/me', exigeLogin, (req, res) => res.json(req.usuario));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Rodando em http://localhost:${PORT}`));
