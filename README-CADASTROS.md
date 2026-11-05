# Cadastro, login e lista de cadastros

O site grava cada cadastro no banco SQLite `wizard.db`, nas tabelas `responsaveis` e `alunos`. A senha nunca é salva em texto: ela é armazenada como hash bcrypt.

## Login “Já sou aluno”

O e-mail informado no primeiro acesso passa a ser o login da página `login.html`. O cadastro cria a conta, inicia a sessão e encaminha para o pagamento. Depois, o mesmo e-mail e a senha escolhida funcionam em `acesso.html` > `Já sou aluno`.

## Lista e planilha

Abra `/admin.html`. Clique em **Carregar lista** e informe a senha do administrador. A tela mostra todos os cadastros criados e permite baixar `cadastros-wip.csv`, compatível com Excel e Google Sheets.

A área administrativa usa usuário `admin` e a variável `ADMIN_SENHA`. Configure-a no ambiente de produção junto com uma chave `JWT_SECRET` aleatória de pelo menos 32 caracteres. Nunca publique o arquivo `.env` nem compartilhe a senha administrativa.

Use `.env.example` como referência. O banco entregue neste pacote contém somente a conta de teste `teste@wizard.com` com senha `1234`; não foram encontrados cadastros reais históricos no `wizard.db` enviado.
