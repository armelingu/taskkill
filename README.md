# Taskkill 🗡️ - Gestor de Tarefas Minimalista (Premium Edition)

O **Taskkill** é uma aplicação hiper-focada em produtividade de alto impacto. Projetada do zero com inspirações no minimalismo da *Linear* e na usabilidade purista do *Things 3*, ela corta qualquer "gordura" das ferramentas de gerenciamento padrão para entregar um fluxo instintivo, veloz e robusto.

---

## 🛠️ O Coração Tecnológico (Core Stack)
Construído sob uma filosofia **No-Bloatware** (sem bibliotecas pesadas), o sistema atua de maneira modular:

- **Backend Otimizado:** Criado em **Python puro + Flask**. As rotas REST comunicam-se via JSON. Sem views acopladas, o Python atua como um servidor Backend real, pronto para evoluir pra uma nuvem ou arquitetura headless, validando segurança dos payloads no meio.
- **Banco de Dados Flexível:** Utilizamos **SQLite 3** num contexto "Serverless", com esquemas migráveis, salvando Data, Status e Rankeamento dinâmico posicional (`position`) em mili-segundos, sem precisarmos lidar com deploys supercomplexos.
- **FrontEnd Premium (Vanilla):** Ao invés de usar React/Vue e subir as barreiras da aplicação, as interfaces (UI/UX) foram cravadas usando nada a não ser **Vanilla JS, HTML Customizado e CSS3 Nativo**. Toda a lógica do aplicativo recai numa renderização instantânea chamada de **Optimistic UI** (a tela redesenha milissegundos antes da nuvem salvar de fato), dando uma sensação visual de `120fps`.

---

## 🔥 Funcionalidades Masterclass Desenvolvidas

Foi investido altíssimo rigor na "Sensação de Uso" de cada botão:

* **1. Dashboard Panorâmico Clicável:** Uma área principal que analisa todos os seus dados em modo pássaro calculando de cabeça quantidades "Abertas x Finalizadas". Cada cartão do Dashboard é interativo (ao clicar, joga o painel da esquerda pro projeto na mesma hora).
* **2. Visão Temporal (Semana):** Navegue entre Dias da Semana (Segunda, Terça, etc) vendo as tarefas cruzadas vindas de todos os projetos simultaneamente.
* **3. Reordenação Visceral (Drag & Drop):** Modifique o ranqueamento das suas tarefas clicando e as arrastando para cima e baixo na lista de prioridade. O App lê o DOM, recalcula a cadeia de posição inteira e envia tudo em pacote de background para o Python injetar a ordenação nova (`PUT /api/tasks/reorder`).
* **4. Organizador Instantâneo por Gravidade:** Você pode catar uma tarefa, arrastá-la pela tela inteira e a *"Soltar"* (`Drop`) em cima da opção da Barra Lateral para alterar a Data ou o Projeto. A tela recebe um contorno visual (Distorção Chumbo Slate em 3D). Sem botões de menu extra, sem clicks repetitivos.
* **5. Hashtag Parser Inline Voador:** Quer colocar tags coloridas nas tarefas? Não precisa de novos cliques ou colunas no banco. É só escrever algo como `"Ligar no banco #urgente #financas"`. O RegEx interno do Javascript engole as palavras acompanhadas do `#` e transforma em *Badges Pills Premium*. 
* **6. Micro-tarefas Naturais (`[ ]`):** Em vez de montar sistemas relacionais pesadíssimos pra subtarefa, fizemos o Frontend resolver isso sozinho. Se uma String dentro do Taskkill conter `[ ] Etapa 1`, o construtor desenha um `Checkbox azul HTML verdadeiro` interceptado em tempo real por um event listener. Uma tarefa pode ter múltiplas subtarefas clicáveis num único input!
* **7. Toast Feedback (Notificações Silenciosas):** Qualquer alteração estrutural no aplicativo ergue dinamicamente um pop-up negro-suave no canto inferior com mensagens tipo: *"Agendado para Sexta"* ou *"Tarefa Removida"*, com FadeIn e FadeOut temporizados sem bloquear o fluxo.
* **8. Segurança Massiva Embarcada:** O banco possui limpeza dos IDs nativa usando tuples em SQL `(?)`, escape de string global do payload contra Script Injection (XSS), Headers enrijecidos com CSP via Flask, e validador de payload limits. 

---

## 🏗️ Estrutura Limpa de Arquivos
```text
📦taskkill
 ┣ 📂app
 ┃ ┣ 📂scripts
 ┃ ┃ ┣ 📜run_local.bat
 ┃ ┃ ┗ 📜run_local.ps1
 ┃ ┣ 📂static
 ┃ ┃ ┣ 📂css
 ┃ ┃ ┃ ┗ 📜style.css (Design System Otimizado "Slate Mod")
 ┃ ┃ ┗ 📂js
 ┃ ┃ ┃ ┗ 📜script.js (Motor Angular do projeto com Async Fetch UI)
 ┃ ┣ 📂templates
 ┃ ┃ ┣ 📜index.html (App)
 ┃ ┃ ┣ 📜login.html (Login)
 ┃ ┃ ┗ 📜admin.html (Admin)
 ┃ ┣ 📜app.py (Lançador do Servidor Flask Minimalista + Middleware Seguranças)
 ┃ ┣ 📜database.py (Otimizador e Migrador autônomo do banco SQLite)
 ┃ ┣ 📜routes.py (Bifurcação de Rotas usando Modelagem de Controllers)
 ┗ 📜README.md
```

## 🚀 Como Rodar o Repositório? (Dev Environment)

1. Crie seu ambiente Virtual no Windows ou Linux:
   `python -m venv .venv`
2. Ative ele:
   `.venv\Scripts\activate`
3. Instale a biblioteca requesitada primordial:
   `pip install -r requirements.txt`
4. Na pasta do app, basta acender a turbina principal:
   `python app.py`
5. Abra o link gerado no terminal (porta **5091**) e acesse `/login`.

---

## 🔒 Segurança (resumo)
- **Sessão + login** (cookies HttpOnly)
- **CSRF** em `POST/PUT/DELETE` na API (`X-CSRF-Token`)
- **Headers** (CSP, anti-clickjacking, etc.)

---

## 🐳 Rodar via Docker (Local / VPS)

1. Crie um arquivo `.env` na pasta `app` e defina pelo menos:
   - `TASKKILL_SECRET_KEY`
   - `TASKKILL_ADMIN_PASSWORD`
   - `TASKKILL_COOKIE_SECURE=0` (local é HTTP)
2. Suba os serviços:
   - `docker compose -f docker-compose.yml -f docker-compose.local.yml up -d --build`
3. Acesse:
   - `http://localhost:5091/`

Notas:
- O banco fica persistido em volume (`taskkill_data`) como `/data/taskkill.db`.
- O Ollama roda somente interno no compose. O serviço `ollama_pull` tenta puxar o modelo automaticamente.

### Integração: chamados → Taskkill (Protheus)
Para criar tarefas automaticamente a partir do seu sistema de chamados (MySQL), adicione no `.env`:

- `CHAMADOS_SYNC_ENABLED=1`
- `CHAMADOS_MYSQL_HOST=SEU_HOST_MYSQL`
- `CHAMADOS_MYSQL_PORT=3306`
- `CHAMADOS_MYSQL_DB=SEU_BANCO`
- `CHAMADOS_MYSQL_USER=root`
- `CHAMADOS_MYSQL_PASSWORD=<sua_senha>`
- `CHAMADOS_AGENT_ID=SEU_AGENT_ID`

E suba normalmente com Docker local. O serviço `chamados_sync` roda em background e importa tickets novos sem duplicar.

---

## 🚀 Subir em uma VPS (Hostinger) com Docker + HTTPS + Senha

### 1) DNS
- Crie um registro **A** no seu domínio apontando para o IP da VPS.

### 2) VPS (Ubuntu) — instalar Docker

```bash
sudo apt update
sudo apt install -y ca-certificates curl git
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker $USER
newgrp docker
docker --version
docker compose version
```

### 3) Deploy do Taskkill

```bash
git clone <seu-repo> taskkill
cd taskkill/app
```

Edite o `.env` e configure:
- `TASKKILL_SECRET_KEY` (segredo longo aleatório)
- `TASKKILL_ADMIN_PASSWORD` (senha inicial do admin)
- `TASKKILL_COOKIE_SECURE=1` (VPS com HTTPS)
- `DOMAIN` (ex.: `taskkill.seudominio.com`)
- `BASIC_AUTH_USER` (seu usuário)
- `BASIC_AUTH_HASH` (hash bcrypt da senha)

Para gerar `BASIC_AUTH_HASH`:

```bash
docker run --rm caddy:2 caddy hash-password --plaintext "SUA_SENHA"
```

Suba os serviços (compose base + overlay da VPS):

```bash
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d --build
```

### 4) Firewall
- Garanta que as portas **80** e **443** estejam liberadas na VPS.

### 5) Acessar
- Abra `https://taskkill.seudominio.com` e autentique (Basic Auth).

Observações:
- O certificado TLS é emitido automaticamente pelo Caddy (Let's Encrypt) quando o DNS estiver correto.
- O `ollama` **não** é exposto para a internet (somente rede interna do Docker).

---

## ✅ Uso local (sem VPS, sem Docker)

O app agora é **web** e exige **login**.

### 1) Configure o `.env` (1ª vez)
Crie/edite o arquivo `.env` na pasta `app` e garanta pelo menos:

- `TASKKILL_SECRET_KEY`: um segredo longo e aleatório
- `TASKKILL_ADMIN_PASSWORD`: uma senha longa (mín. 10 caracteres)
- `TASKKILL_COOKIE_SECURE=0` (local é HTTP)

Obs: o sistema cria o usuário admin no primeiro boot (se não existir nenhum usuário).

Se você **esquecer a senha** do admin, basta ajustar `TASKKILL_ADMIN_PASSWORD` no `.env` e rodar:

```powershell
python scripts\reset_admin_password.py
```

### 2) Rodar com 1 clique (Windows)
- Execute:
  - `scripts\\run_local.bat`
  - ou `scripts\\run_local.ps1`

Se você quiser subir **o app + o sync de chamados** junto (mais automático):
- `scripts\\run_local_all.bat`
- ou `scripts\\run_local_all.ps1`

### 3) Rodar manualmente (Windows / PowerShell)

```powershell
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python serve.py
```

### 3.1) (Opcional) Deixar o sync sempre rodando (Agendador do Windows)
Isso faz o sync iniciar automaticamente no seu **logon** do Windows.

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install_sync_task.ps1 -Hidden
```

Para remover:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\uninstall_sync_task.ps1
```

### 4) Acessar
- Abra a URL que o terminal imprimir e entre em:
  - `http://127.0.0.1:<porta>/login`

---

---
*"Feito com excelência para quem vive com excelência."*
