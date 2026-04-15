# Taskkill

Gerenciador de tarefas e projetos com interface web minimalista, grafo de dependências interativo e integração com sistemas externos de chamados.

## Stack

- **Backend:** Python 3 + Flask, SQLite 3 (WAL mode), Werkzeug Security
- **Frontend:** Vanilla JS, HTML5, CSS3 — sem frameworks externos
- **Autenticação:** Sessions com CSRF, rate limiting, cookies HttpOnly/SameSite
- **Integração:** MySQL (polling de chamados externos via `pymysql`)
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
- Integração com sistema de chamados MySQL: importação automática de tickets com ordenação por prioridade e status

## Estrutura

```
app/
├── app.py                  # Inicialização Flask, middlewares e headers de segurança
├── database.py             # Schema, migrações e bootstrap do banco SQLite
├── routes.py               # Blueprints REST (tasks, projects, auth, admin)
├── requirements.txt
├── .env.example            # Variáveis de ambiente necessárias
├── static/
│   ├── css/style.css
│   └── js/script.js
├── templates/
│   ├── index.html
│   ├── login.html
│   └── admin.html
├── scripts/
│   ├── sync_chamados.py        # Polling MySQL → tasks (Protheus)
│   ├── reset_admin_password.py
│   ├── run_local.bat / .ps1
│   ├── run_local_all.bat / .ps1
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

## Integração com chamados (MySQL)

Configure no `.env`:

```env
CHAMADOS_SYNC_ENABLED=1
CHAMADOS_MYSQL_HOST=seu_host
CHAMADOS_MYSQL_PORT=3306
CHAMADOS_MYSQL_DB=seu_banco
CHAMADOS_MYSQL_USER=seu_usuario
CHAMADOS_MYSQL_PASSWORD=sua_senha
CHAMADOS_AGENT_ID=SEU_AGENT_ID
CHAMADOS_POLL_SECONDS=45
```

O serviço `sync_chamados.py` faz polling no intervalo definido, cria tasks no projeto "Protheus" para tickets novos e marca como concluídas as que estiverem com status FECHADO/RESOLVIDO/CANCELADO/FINALIZADO. A importação é idempotente (tabela `chamados_sync`).

**Agendar sync no logon do Windows:**
```powershell
powershell -ExecutionPolicy Bypass -File scripts\install_sync_task.ps1 -Hidden
```

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
