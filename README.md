# Taskkill

Gerenciador de tarefas e projetos com interface web minimalista, grafo de dependências interativo e autenticação segura.

## Origem

Nunca consegui usar nenhum sistema de gerenciamento de tarefas por muito tempo. Notion, Trello, Linear, Things — testei vários, e no final sempre voltava ao papel. Não por falta de funcionalidade, mas porque nenhum deles refletia a forma como eu realmente pensava e organizava as coisas.

No papel eu tinha uma estrutura simples que funcionava: projetos separados, uma visão da semana e conexões visuais entre o que dependia do quê. Certo dia decidi digitalizar exatamente isso — sem tentar replicar nenhuma ferramenta existente, só transportar o que já funcionava.

O Taskkill nasceu disso. A visão semanal, os projetos como categorias e o grafo de dependências são exatamente os três elementos que eu usava no papel. A inspiração para o grafo veio do Obsidian, que trouxe conexões visuais para gestão de conhecimento — aqui a ideia é a mesma, mas aplicada a tarefas.

A maioria dos gerenciadores de tarefas é lista ou kanban. O Taskkill não tenta ser mais um — ele é a estrutura que funcionou para mim, construída do jeito que eu precisava que fosse.

## Stack

- **Backend:** Python 3 + Flask, SQLite 3 (WAL mode), Werkzeug Security
- **Frontend:** Vanilla JS, HTML5, CSS3 — sem frameworks externos
- **Autenticação:** Sessions com CSRF, rate limiting, cookies HttpOnly/SameSite
- **Deploy:** Docker + Docker Compose, Caddy (reverse proxy + TLS automático)

## Funcionalidades

- Projetos dinâmicos: criação e exclusão com soft-delete de tasks
- Visualização semanal com drag-and-drop entre dias e projetos
- Dashboard com contagem de tarefas abertas/concluídas por projeto
- Grafo de dependências interativo (Canvas 2D, force-directed layout)
- Hashtags inline parseadas e renderizadas como badges
- Subtarefas via sintaxe `[ ]` no corpo da tarefa
- Optimistic UI: atualização visual imediata antes da resposta do servidor
- Backup e restore do banco via painel admin

## Estrutura

```
app/
├── app.py                  # Inicialização Flask, middlewares e headers de segurança
├── database.py             # Schema, migrações e bootstrap do banco SQLite
├── routes.py               # Blueprints REST (tasks, projects, auth, admin)
├── requirements.txt
├── .env.example
├── static/
│   ├── css/style.css
│   └── js/script.js
├── templates/
│   ├── index.html
│   ├── login.html
│   └── admin.html
├── scripts/
│   ├── reset_admin_password.py
│   ├── run_local.bat / .ps1
│   ├── install_sync_task.ps1
│   └── uninstall_sync_task.ps1
├── docker-compose.yml
└── docker-compose.local.yml
```

## Configuração

Copie `.env.example` para `.env` e preencha as variáveis:

```bash
cp .env.example .env
```

Variáveis obrigatórias:

| Variável | Descrição |
|---|---|
| `TASKKILL_SECRET_KEY` | Chave secreta Flask (mín. 32 chars aleatórios) |
| `TASKKILL_ADMIN_PASSWORD` | Senha do admin inicial (mín. 10 chars) |
| `TASKKILL_COOKIE_SECURE` | `0` em HTTP local, `1` em HTTPS/produção |

## Uso local (sem Docker)

**Windows — 1 clique:**
```
scripts\run_local.bat
```

**Manual (PowerShell):**
```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

Acesse `http://127.0.0.1:5091/login`.

O usuário admin é criado automaticamente no primeiro boot se não existir nenhum usuário no banco.

**Resetar senha do admin:**
```powershell
python scripts\reset_admin_password.py
```

## Uso local com Docker

```bash
docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build
```

## Deploy em VPS (Ubuntu + HTTPS)

**1. Instalar Docker:**
```bash
sudo apt update && sudo apt install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER && newgrp docker
```

**2. Clonar e configurar:**
```bash
git clone https://github.com/armelingu/taskkill taskkill
cd taskkill/app
cp .env.example .env
# editar .env: TASKKILL_COOKIE_SECURE=1, DOMAIN, BASIC_AUTH_USER, BASIC_AUTH_HASH
```

**3. Gerar hash de senha para autenticação Basic Auth (Caddy):**
```bash
docker run --rm caddy:2 caddy hash-password --plaintext "SUA_SENHA"
```

**4. Subir:**
```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build
```

O certificado TLS é emitido automaticamente pelo Caddy via Let's Encrypt. Portas 80 e 443 devem estar liberadas no firewall da VPS.

## Integrações externas

Módulo em desenvolvimento. O objetivo é oferecer um sistema genérico e configurável para importar dados de fontes externas — APIs REST, bancos SQL, webhooks — e criar tasks automaticamente no Taskkill, com suporte a mapeamento de campos, deduplicação e controle de status.

## Segurança

- CSRF token obrigatório em todos os endpoints mutáveis (`POST`, `PUT`, `DELETE`)
- Rate limiting de login: 5 tentativas, bloqueio de 15 minutos por IP
- Regeneração de session ID após autenticação (prevenção de session fixation)
- Headers: CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy
- Queries parametrizadas em todo acesso ao banco
- Payload limitado a 1 MB (`MAX_CONTENT_LENGTH`)

## Branches

| Branch | Descrição |
|---|---|
| `master` | Código estável |
| `desenv` | Desenvolvimento ativo |
| `feature/*` | Features individuais |
