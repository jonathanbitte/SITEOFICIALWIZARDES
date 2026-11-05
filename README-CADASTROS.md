# Área administrativa de cadastros

A área administrativa está em `public/admin.html` e exige login com as variáveis `ADMIN_USER` e `ADMIN_SENHA` configuradas no ambiente do Render.

O backend define uma sessão administrativa independente, em cookie HTTP-only. As rotas de listagem, exportação CSV/XLS e reset exigem essa sessão. A rota de reset também verifica a origem autorizada.

Não compartilhe a senha administrativa. Configure uma senha forte e exclusiva diretamente no Render.
