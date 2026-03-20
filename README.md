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
 ┃ ┣ 📂static
 ┃ ┃ ┣ 📂css
 ┃ ┃ ┃ ┗ 📜style.css (Design System Otimizado "Slate Mod")
 ┃ ┃ ┗ 📂js
 ┃ ┃ ┃ ┗ 📜script.js (Motor Angular do projeto com Async Fetch UI)
 ┃ ┣ 📂templates
 ┃ ┃ ┗ 📜index.html (Casca HTML e navegações Master)
 ┃ ┣ 📜app.py (Lançador do Servidor Flask Minimalista + Middleware Seguranças)
 ┃ ┣ 📜database.py (Otimizador e Migrador autônomo do banco SQLite)
 ┃ ┣ 📜routes.py (Bifurcação de Rotas usando Modelagem de Controllers)
 ┃ ┗ 📜taskkill.db 
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
5. Abra o link gerado no terminal (porta **5091**). Ele auto-criará o Banco de Dados (`taskkill.db`) caso não exista assim que carregar a memória RAM.

---

## 🔒 Modo Produto Local (Recomendado)

- **Rodar com servidor estável (Waitress)**:
  - `python serve.py`
  - Ele abre o navegador automaticamente e usa **porta dinâmica** (ou fixe com `TASKKILL_PORT=5091`).

- **Banco de dados em modo produto**:
  - O SQLite passa a ficar em `%LOCALAPPDATA%\\Taskkill\\taskkill.db`
  - Override (dev/test): `TASKKILL_DB_PATH=C:\\caminho\\para\\taskkill.db`

- **Proteção anti “drive-by localhost”**:
  - Todas as rotas `/api/*` exigem o header `X-Taskkill-Token` (injetado no HTML via `<meta>` e enviado pelo JS automaticamente).

---

## 🐳 Rodar via Docker (Local / VPS)

1. Crie um arquivo `.env` baseado no exemplo:
   - `copy .env.example .env`
   - Edite `TASKKILL_API_TOKEN` (use um token longo e aleatório)
2. Suba os serviços:
   - `docker compose up -d --build`
3. Acesse:
   - `http://localhost:5091/`

Notas:
- O banco fica persistido em volume (`taskkill_data`) como `/data/taskkill.db`.
- O Ollama roda somente interno no compose. O serviço `ollama_pull` tenta puxar o modelo automaticamente.

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
cp .env.example .env
```

Edite o `.env` e configure:
- `TASKKILL_API_TOKEN` (token longo aleatório)
- `DOMAIN` (ex.: `taskkill.seudominio.com`)
- `BASIC_AUTH_USER` (seu usuário)
- `BASIC_AUTH_HASH` (hash bcrypt da senha)

Para gerar `BASIC_AUTH_HASH`:

```bash
docker run --rm caddy:2 caddy hash-password --plaintext "SUA_SENHA"
```

Suba os serviços (compose base + overlay da VPS):

```bash
docker compose up -d --build
docker compose -f docker-compose.yml -f docker-compose.vps.yml up -d
```

### 4) Firewall
- Garanta que as portas **80** e **443** estejam liberadas na VPS.

### 5) Acessar
- Abra `https://taskkill.seudominio.com` e autentique (Basic Auth).

Observações:
- O certificado TLS é emitido automaticamente pelo Caddy (Let's Encrypt) quando o DNS estiver correto.
- O `ollama` **não** é exposto para a internet (somente rede interna do Docker).

---

## 📦 Empacotar como Executável (.exe) no Windows

1. Instale dependências:
   - `pip install -r requirements.txt`
   - `pip install pyinstaller`
2. Build (recomendado via script):
   - `powershell -ExecutionPolicy Bypass -File .\\build_exe.ps1`
3. Saída:
   - O executável fica em `dist\\Taskkill\\Taskkill.exe` (ou `dist\\Taskkill.exe` se `--onefile`)

Dicas:
- Para build sem console: `powershell -ExecutionPolicy Bypass -File .\\build_exe.ps1 -NoConsole`
- Se quiser fixar porta no exe: defina `TASKKILL_PORT=5091` no ambiente antes de rodar.

---
*"Feito com excelência para quem vive com excelência."*
