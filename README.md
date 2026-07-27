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
taskkill/
├── app.py                     # Inicialização Flask, middlewares e headers de segurança
├── database.py                # Schema, migrações e bootstrap do banco SQLite
├── routes.py                  # Blueprints REST (tasks, projects, auth, perfil, backup, integrações)
├── integrations.py            # Núcleo das integrações externas (REST/JSON -> tasks)
├── scheduler.py               # Agendador in-process das integrações (thread daemon)
├── serve.py                   # Servidor WSGI local (waitress)
├── requirements.txt
├── .env.example
├── static/
│   ├── css/style.css
│   ├── js/script.js
│   └── favicon.svg
├── templates/
│   ├── index.html
│   ├── login.html
│   └── perfil.html
├── scripts/
│   ├── reset_admin_password.py
│   └── run_local.bat / .ps1
├── Dockerfile
├── Caddyfile
├── docker-compose.yml         # Base (app)
├── docker-compose.local.yml   # Overlay para uso local
└── docker-compose.vps.yml     # Overlay para produção (Caddy + HTTPS)
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
python serve.py    # produção local (waitress); use `python app.py` para o modo dev
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
cd taskkill
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

Módulo genérico para importar itens de uma API REST/JSON como tarefas, configurado por uma interface amigável (ou por JSON bruto). Acessível pelo item **Integrações** no menu lateral (apenas admin).

**Fluxo (wizard):**

1. **Conexão** — nome, URL da API, autenticação e (avançado) método/headers/query, paginação e agendamento.
2. **Itens** — "Buscar dados" busca a resposta e sugere onde está a lista (`items_path`) e os campos disponíveis.
3. **Tarefa** — campo de ID único (deduplicação), projeto de destino (fixo ou vindo de um campo), texto via template seguro `{{ campo }}` e política de atualização.
4. **Revisar** — prévia interativa: escolha por linha o dia da semana e o projeto (ou em massa), marque o que importar e importe de fato.

O bloco **Editar como JSON** expõe a mesma configuração declarativa para importar/exportar/editar diretamente.

**Autenticação suportada:** nenhuma, Bearer token, API key em header, chave/token na query, Basic (usuário/senha) e OAuth2 *client credentials* (busca o `access_token` num token endpoint e o usa como Bearer).

**Paginação:** sem paginação (padrão), por número de página, por offset ou por cursor/`next` (segue um token ou URL na resposta). Teto de segurança de páginas por execução.

**Atualização / deduplicação:** dedup por `external_id`. Se um item já foi importado, é possível ignorar, atualizar só o texto, ou atualizar texto + projeto + dia. Um `content_hash` evita updates desnecessários e há a opção de recriar tarefas que foram excluídas depois de importadas.

**Agendamento automático:** cada integração pode rodar sozinha a cada N minutos (mínimo 5). Uma thread daemon in-process reserva execuções vencidas com um *compare-and-set* atômico em `next_run_at` (seguro no deploy single-worker; sem duplicidade mesmo com múltiplos processos). Controle por `TASKKILL_SCHEDULER` (0 desliga) e `TASKKILL_SCHEDULER_TICK` (segundos entre varreduras).

**Histórico:** cada execução (manual, revisão interativa ou agendada) é registrada em `integration_runs` com contagens e erro; visível pelo botão **Histórico** no card da integração.

**Modelo de dados:** `integrations` (config + status + agendamento), `integration_items` (dedup por `external_id`, `content_hash` e vínculo com a task) e `integration_runs` (log de execuções).

**Segurança:** endpoints restritos a admin + CSRF; guarda de SSRF (bloqueia por padrão IPs privados/loopback/metadata de cloud, inclusive no token endpoint do OAuth2 — há um toggle "permitir rede interna"); timeout de 10s e limite de 5 MB na resposta; segredos mascarados nas respostas da API e preservados em atualizações. O mapeamento usa apenas templates `{{ campo }}` — nunca executa código arbitrário.

**Fora do escopo (próximas fases):** fontes SQL e webhooks, e criptografia dos segredos em repouso.

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
