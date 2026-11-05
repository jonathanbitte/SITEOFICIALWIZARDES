# Migração do backend Wizard para MySQL

## Arquitetura

- Frontend: UOL Host (`https://wizardes.com.br`)
- API: Render (`https://api.wizardes.com.br`)
- Banco: MySQL UOL Host
- Driver: `mysql2/promise`
- O arquivo `wizard.db` original não deve ser enviado ao Git nem apagado.

## 1. Variáveis do Render

Configure no serviço Node do Render:

- `NODE_ENV=production`
- `DB_HOST`: hostname **externo** fornecido pela UOL Host. Não presuma que `10.132.36.3` seja acessível pelo Render; esse endereço é privado.
- `DB_PORT=3306` (confirme a porta no painel UOL)
- `DB_NAME=wizardesf7b279ee_wizard`
- `DB_USER=wizardesf7b279ee_admin`
- `DB_PASSWORD`: senha cadastrada diretamente no painel do Render
- `JWT_SECRET`: mantenha o segredo atual, desde que tenha 32 caracteres ou mais
- `ADMIN_USER=admin`
- `ADMIN_SENHA`: senha administrativa forte, exclusiva, com pelo menos 12 caracteres
- `CORS_ORIGINS=https://wizardes.com.br,https://www.wizardes.com.br`

Não coloque senhas no Git, em arquivos JavaScript ou em mensagens.

## 2. Dependências

Na pasta do projeto, execute:

```bash
npm install
```

`mysql2` é dependência de produção. `better-sqlite3` fica temporariamente em `devDependencies` apenas para o utilitário de migração. O servidor em produção não importa nem usa SQLite.

## 3. Migração dos dados

O script `migrate-sqlite-to-mysql.js` lê o banco SQLite indicado e grava os registros no MySQL, preservando IDs, hashes bcrypt, relações e timestamps.

Execute no computador que tenha o `wizard.db` original:

```bash
npm run migrate:sqlite -- "C:\caminho\para\wizard.db"
```

No macOS/Linux:

```bash
npm run migrate:sqlite -- "/caminho/para/wizard.db"
```

Antes de executar, configure no ambiente local as mesmas variáveis `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER` e `DB_PASSWORD`. Não escreva a senha no comando nem no histórico do terminal; use variáveis de ambiente temporárias ou um gerenciador de segredos.

**Atenção à conectividade:** o MySQL precisa aceitar a conexão do computador em que o script será executado. O cPanel atualmente tem as faixas do Render autorizadas; se executar a migração localmente, a UOL pode exigir também a liberação do IP público de saída desse computador. O host privado `10.132.36.3` não deve ser substituído por um endereço inventado. Peça à UOL o hostname de conexão externa para aplicações fora da rede da hospedagem.

O script:
- cria as tabelas se ainda não existirem;
- não exibe dados pessoais nos logs;
- interrompe se o MySQL já tiver responsáveis ou alunos, para evitar duplicação;
- pode substituir somente as tabelas de escolas/séries quando elas contêm apenas a carga inicial e ainda não há cadastros;
- usa transação;
- confere as quantidades após a cópia;
- não remove nem modifica o `wizard.db` original.

Não execute a migração repetidamente depois de uma cópia bem-sucedida sem antes avaliar o conteúdo do MySQL.

## 4. Deploy e ordem recomendada

1. Confirme com a UOL o hostname externo e a porta do MySQL.
2. Configure as variáveis no Render. Não altere o DNS principal nem o CNAME `api.wizardes.com.br`.
3. Execute a migração SQLite → MySQL a partir de um computador com conectividade autorizada.
4. Faça o deploy do backend atualizado no Render.
5. Publique os arquivos de `public/` na hospedagem UOL, mantendo `api-config.js` junto das páginas.
6. Confirme nos logs do Render que a API inicializou e conectou ao MySQL.
7. Só depois da confirmação, considere o MySQL como banco ativo. Guarde o SQLite original em backup seguro.

Se a conectividade externa da UOL ainda não estiver confirmada, não remova nem desative a implantação atual que usa SQLite. O novo backend exige conexão MySQL no início e não inicia se a conexão falhar.

## 5. Frontend, CORS e cookies

As páginas que usam a API chamam `apiFetch()` definido em `public/api-config.js`. Ele aponta para `https://api.wizardes.com.br` e envia `credentials: 'include'`.

O backend autoriza por padrão `wizardes.com.br` e `www.wizardes.com.br`. Se o frontend for publicado em outro host, adicione a origem exata em `CORS_ORIGINS` no Render.

O cookie `sessao` é HTTP-only, Secure em produção e SameSite=Lax. Como o frontend e a API usam HTTPS no mesmo domínio registrável (`wizardes.com.br`), as chamadas entre subdomínios são same-site, embora sejam cross-origin.

## 6. Administração

A página `admin.html` agora exige autenticação administrativa. Configure `ADMIN_USER` e `ADMIN_SENHA` no Render. O login cria um cookie administrativo HTTP-only separado do cookie dos responsáveis.

As rotas abaixo exigem sessão administrativa válida:
- `GET /admin/cadastros.json`
- `GET /admin/cadastros.xls`
- `GET /admin/cadastros.csv`
- `POST /admin/cadastros/reset`

A rota de reset também valida a origem autorizada. Não compartilhe a senha administrativa.

## 7. Arquivos importantes

- `db.js`: pool MySQL, schema e carga inicial de escolas/séries/links Cielo.
- `server.js`: rotas assíncronas, sessão, CORS e autenticação administrativa.
- `migrate-sqlite-to-mysql.js`: migração pontual dos dados.
- `public/api-config.js`: endereço central da API para o frontend.
- `public/admin.html`: login e painel administrativo.


## Tentativa direta de conexão pelo Render

Para a primeira tentativa, configure no painel do Render (Environment):

- `DB_HOST=10.132.36.3`
- `DB_PORT=3306`
- `DB_NAME=wizardesf7b279ee_wizard`
- `DB_USER=wizardesf7b279ee_admin`
- `DB_PASSWORD`: informe diretamente no painel do Render, nunca no chat ou no repositório.

Mantenha `JWT_SECRET` atual e configure também `ADMIN_USER` e `ADMIN_SENHA` conforme a documentação. Salve e faça um novo deploy. O servidor tenta conectar ao MySQL antes de abrir a porta HTTP; se a conexão falhar, o log mostra o código do erro e o processo encerra, evitando que a API opere sem banco.

`10.132.36.3` é o IP privado informado no cPanel. Esta tentativa só será conclusiva quando executada pelo ambiente do Render; um teste de rede feito em outro provedor não confirma nem descarta a conectividade do Render.
