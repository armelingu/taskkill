// Tema claro/escuro — persiste a escolha e respeita a preferência do sistema no 1º acesso.
(function () {
  const root = document.documentElement;
  const toggle = document.getElementById("themeToggle");
  const STORAGE_KEY = "taskkill-mockup-theme";

  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored) {
    root.setAttribute("data-theme", stored);
  } else if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
    root.setAttribute("data-theme", "dark");
  }

  function currentTheme() {
    return root.getAttribute("data-theme") === "dark" ? "dark" : "light";
  }

  // Reaplica ?theme=... apenas nos iframes JÁ carregados (que têm src). Os que
  // ainda não entraram na viewport permanecem sem carregar — assim o toggle de
  // tema não força o download antecipado das telas pesadas.
  function syncShotsTheme() {
    const theme = currentTheme();
    document.querySelectorAll(".shot__frame").forEach((frame) => {
      const base = frame.getAttribute("data-screen");
      if (base && frame.src) frame.src = `${base}?theme=${theme}`;
    });
  }

  // Troca o poster estático (hero) entre claro/escuro conforme o tema.
  // Guard: só reatribui o src se o arquivo desejado for diferente do atual
  // (evita refetch da imagem de LCP no caminho claro, que já vem no HTML).
  function syncPosters() {
    const theme = currentTheme();
    document.querySelectorAll("img[data-poster]").forEach((img) => {
      const file = `${img.getAttribute("data-poster")}-${theme}.webp`;
      if (!(img.getAttribute("src") || "").includes(file)) {
        img.src = `/static/landing/posters/${file}`;
      }
    });
  }
  // Aplica já no carregamento (troca para o poster escuro se o tema for escuro).
  syncPosters();

  toggle?.addEventListener("click", () => {
    const next = currentTheme() === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    localStorage.setItem(STORAGE_KEY, next);
    syncShotsTheme();
    syncPosters();
  });

  // Escala cada iframe (renderizado em 1280×820) para caber na largura do container,
  // e ajusta a altura do viewport recortado de acordo.
  const SHOT_W = 1280;
  const SHOT_H = 820;
  function fitShots() {
    document.querySelectorAll(".shot__viewport").forEach((vp) => {
      const frame = vp.querySelector(".shot__frame");
      if (!frame) return;
      const k = vp.clientWidth / SHOT_W;
      frame.style.setProperty("--shot-k", String(k));
      vp.style.height = `${SHOT_H * k}px`;
    });
  }

  window.addEventListener("resize", fitShots);
  window.addEventListener("load", fitShots);
  fitShots();

  // LCP/carga: o hero é uma imagem leve; os iframes de tela (galeria/carrossel)
  // ficam TODOS abaixo da dobra. Em vez de carregá-los em massa, cada um só
  // recebe src quando chega perto da viewport. Isso mantém o load inicial enxuto
  // (sem puxar o CSS do app) e deixa a main-thread livre para pintar o hero.
  (function lazyLoadShots() {
    const frames = document.querySelectorAll(".shot__frame[data-screen]");
    if (!frames.length) return;
    const load = (frame) => {
      if (frame.src) return;
      frame.src = `${frame.getAttribute("data-screen")}?theme=${currentTheme()}`;
    };
    if (!("IntersectionObserver" in window)) {
      frames.forEach(load);
      return;
    }
    const io = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            load(e.target);
            obs.unobserve(e.target);
          }
        });
      },
      { rootMargin: "300px 0px" }
    );
    frames.forEach((f) => io.observe(f));
  })();

  // ---------- Carrossel "Por dentro" ----------
  const carousel = document.querySelector("[data-carousel]");
  if (carousel) {
    const track = carousel.querySelector("[data-carousel-track]");
    const items = Array.from(track.querySelectorAll(".carousel__item"));
    const dotsWrap = carousel.querySelector("[data-carousel-dots]");
    const prevBtn = document.querySelector("[data-carousel-prev]");
    const nextBtn = document.querySelector("[data-carousel-next]");
    const counter = document.querySelector("[data-carousel-counter]");
    const n = items.length;
    const pad2 = (x) => String(x).padStart(2, "0");
    let dots = [];

    function itemStep() {
      const gap = parseFloat(getComputedStyle(track).columnGap || "0") || 0;
      return items[0].getBoundingClientRect().width + gap;
    }
    // Quantos cards cabem por vez (2 no desktop, 1 no mobile)
    function visibleCount() {
      return Math.max(1, Math.round(track.clientWidth / itemStep()));
    }
    // Número de posições de janela (páginas). Ex.: 4 cards, 2 visíveis => 3 posições
    function pageCount() {
      return Math.max(1, n - visibleCount() + 1);
    }
    function maxIndex() {
      return pageCount() - 1;
    }
    function activeIndex() {
      return Math.max(0, Math.min(maxIndex(), Math.round(track.scrollLeft / itemStep())));
    }
    function scrollToItem(i) {
      const idx = Math.max(0, Math.min(maxIndex(), i));
      track.scrollTo({ left: idx * itemStep(), behavior: "smooth" });
    }

    // (Re)cria as bolinhas conforme o número de páginas atual
    function buildDots() {
      const count = pageCount();
      if (dots.length === count) return;
      dotsWrap.innerHTML = "";
      dots = Array.from({ length: count }, (_, i) => {
        const b = document.createElement("button");
        b.className = "carousel__dot";
        b.type = "button";
        b.setAttribute("aria-label", `Ir para a posição ${i + 1}`);
        b.addEventListener("click", () => scrollToItem(i));
        dotsWrap.appendChild(b);
        return b;
      });
    }

    function update() {
      const i = activeIndex();
      dots.forEach((d, di) => d.classList.toggle("is-active", di === i));
      if (counter) counter.textContent = `${pad2(i + 1)} / ${pad2(pageCount())}`;
      if (prevBtn) prevBtn.disabled = i <= 0;
      if (nextBtn) nextBtn.disabled = i >= maxIndex();
    }

    prevBtn?.addEventListener("click", () => scrollToItem(activeIndex() - 1));
    nextBtn?.addEventListener("click", () => scrollToItem(activeIndex() + 1));

    let scrollRaf = null;
    track.addEventListener("scroll", () => {
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
      scrollRaf = requestAnimationFrame(update);
    });
    window.addEventListener("resize", () => {
      buildDots();
      // reencaixa (sem animação) caso a posição atual passe do novo limite
      track.scrollLeft = Math.min(track.scrollLeft, maxIndex() * itemStep());
      update();
    });

    // Arrastar com o mouse (além do touch/trackpad nativo)
    let dragging = false, startX = 0, startScroll = 0, moved = false;
    track.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      dragging = true; moved = false;
      startX = e.clientX; startScroll = track.scrollLeft;
      track.classList.add("is-dragging");
      track.setPointerCapture(e.pointerId);
    });
    track.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (Math.abs(dx) > 4) moved = true;
      track.scrollLeft = startScroll - dx;
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      track.classList.remove("is-dragging");
      try { track.releasePointerCapture(e.pointerId); } catch (_) {}
      scrollToItem(activeIndex()); // encaixa no item mais próximo
    }
    track.addEventListener("pointerup", endDrag);
    track.addEventListener("pointercancel", endDrag);
    // Evita "clique fantasma" após arrastar
    track.addEventListener("click", (e) => { if (moved) { e.preventDefault(); e.stopPropagation(); } }, true);

    // Teclado (setas) quando o carrossel está focado
    track.tabIndex = 0;
    track.setAttribute("role", "group");
    track.setAttribute("aria-label", "Use as setas para navegar entre as telas");
    track.addEventListener("keydown", (e) => {
      if (e.key === "ArrowRight") { e.preventDefault(); scrollToItem(activeIndex() + 1); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); scrollToItem(activeIndex() - 1); }
    });

    buildDots();
    update();
  }

  // FAQ: mantém no máximo um item aberto por vez (comportamento de acordeão).
  const items = document.querySelectorAll(".faq__item");
  items.forEach((item) => {
    item.addEventListener("toggle", () => {
      if (item.open) {
        items.forEach((other) => {
          if (other !== item) other.open = false;
        });
      }
    });
  });

  // ---------------------------------------------------------------
  // Animações de entrada — a landing "conta" o produto ao rolar.
  // Cada seção revela como um nó; os passos viram um checklist que
  // se completa em sequência (a última = "matar a tarefa").
  // ---------------------------------------------------------------
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  // Escalonamento: cada filho revelado entra um pouco depois do anterior.
  document.querySelectorAll("[data-stagger]").forEach((group) => {
    group.querySelectorAll("[data-reveal]").forEach((child, i) => {
      child.style.setProperty("--d", i * 90 + "ms");
    });
  });

  const steps = document.querySelector("[data-steps]");

  function checkStepsSequence() {
    if (!steps) return;
    const list = steps.querySelectorAll(".step");
    if (reduceMotion) {
      list.forEach((s) => s.classList.add("is-checked"));
      return;
    }
    // Marca cada nó depois que a "aresta" começa a se desenhar.
    list.forEach((step, i) => {
      setTimeout(() => step.classList.add("is-checked"), 450 + i * 380);
    });
  }

  const revealTargets = document.querySelectorAll("[data-reveal]");
  if (!("IntersectionObserver" in window) || reduceMotion) {
    revealTargets.forEach((el) => el.classList.add("in"));
    checkStepsSequence();
  } else {
    const io = new IntersectionObserver(
      (entries, obs) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("in");
          if (entry.target === steps) checkStepsSequence();
          obs.unobserve(entry.target);
        });
      },
      { threshold: 0.18, rootMargin: "0px 0px -8% 0px" }
    );
    revealTargets.forEach((el) => io.observe(el));
    // O bloco de passos dispara a sequência do checklist.
    if (steps) io.observe(steps);
  }
})();

// ===================================================================
// Fundo em grafo — uma "rota" de nós/arestas que percorre a página
// inteira, ligando as seções como no grafo do produto. A rota se
// desenha conforme a rolagem e um pulso viaja por ela (o "sinal").
// ===================================================================
(function () {
  const SVGNS = "http://www.w3.org/2000/svg";
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const sections = Array.from(document.querySelectorAll("main > section"));
  if (!sections.length) return;

  const layer = document.createElement("div");
  layer.className = "bg-graph";
  layer.setAttribute("aria-hidden", "true");
  const svg = document.createElementNS(SVGNS, "svg");
  svg.setAttribute("preserveAspectRatio", "none");
  layer.appendChild(svg);
  document.body.insertBefore(layer, document.body.firstChild);

  const mk = (name, attrs) => {
    const el = document.createElementNS(SVGNS, name);
    for (const k in attrs) el.setAttribute(k, attrs[k]);
    return el;
  };

  let route = null;
  let comet = null;
  let pathLen = 0;
  let nodeEls = [];

  function docHeight() {
    return Math.max(
      document.body.scrollHeight,
      document.documentElement.scrollHeight,
      document.body.offsetHeight
    );
  }

  function build() {
    const W = document.documentElement.clientWidth;
    const H = docHeight();
    layer.style.height = H + "px";
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    nodeEls = [];

    // Um "nó" por seção, alternando lados para formar uma rota em ziguezague.
    const pts = sections.map((el, i) => {
      const r = el.getBoundingClientRect();
      const top = r.top + window.scrollY;
      const side = i % 2 === 0 ? 0.15 : 0.85;
      const jitter = (((i * 53) % 7) - 3) * 0.014;
      const x = Math.round(W * Math.min(0.92, Math.max(0.08, side + jitter)));
      const y = Math.round(top + Math.min(r.height * 0.42, 190));
      return { x, y, el };
    });

    // Rota suave (curvas em S entre nós consecutivos).
    let d = `M ${pts[0].x} ${pts[0].y}`;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], b = pts[i];
      const my = (a.y + b.y) / 2;
      d += ` C ${a.x} ${my}, ${b.x} ${my}, ${b.x} ${b.y}`;
    }

    svg.appendChild(mk("path", { d, class: "bgg-track", fill: "none" }));

    // Arestas cruzadas (nó i → i+2) para dar densidade de grafo.
    for (let i = 0; i + 2 < pts.length; i++) {
      const a = pts[i], b = pts[i + 2];
      svg.appendChild(mk("line", { x1: a.x, y1: a.y, x2: b.x, y2: b.y, class: "bgg-link" }));
    }

    route = mk("path", { d, class: "bgg-route", fill: "none" });
    svg.appendChild(route);

    // Ramos + satélites + nós principais (textura de grafo).
    pts.forEach((p, i) => {
      // dois ramos por nó, em direções diferentes
      const branches = [
        { bx: p.x + (i % 2 ? -1 : 1) * Math.round(W * 0.08), by: p.y - 46, r: 3.6 },
        { bx: p.x + (i % 2 ? 1 : -1) * Math.round(W * 0.045), by: p.y + 58, r: 2.8 },
      ];
      branches.forEach((b) => {
        svg.appendChild(mk("line", { x1: p.x, y1: p.y, x2: b.bx, y2: b.by, class: "bgg-branch" }));
        svg.appendChild(mk("circle", { cx: b.bx, cy: b.by, r: b.r, class: "bgg-sat" }));
      });
      const ring = mk("circle", { cx: p.x, cy: p.y, r: 13, class: "bgg-ring" });
      const node = mk("circle", { cx: p.x, cy: p.y, r: 6.5, class: "bgg-node" });
      svg.appendChild(ring);
      svg.appendChild(node);
      nodeEls.push({ node, ring, el: p.el });
    });

    pathLen = route.getTotalLength();
    route.style.strokeDasharray = pathLen;

    if (reduce) {
      route.style.strokeDashoffset = 0;
    } else {
      route.style.strokeDashoffset = pathLen;
      comet = mk("circle", { r: 5.5, class: "bgg-comet" });
      svg.appendChild(comet);
    }

    observeNodes();
    onScroll();
  }

  function progress() {
    const max = docHeight() - window.innerHeight;
    return max > 0 ? Math.min(1, Math.max(0, window.scrollY / max)) : 1;
  }

  function onScroll() {
    if (reduce || !route) return;
    route.style.strokeDashoffset = pathLen * (1 - progress());
  }

  // Acende o nó da seção que está na tela.
  let nodeIO = null;
  function observeNodes() {
    if (nodeIO) nodeIO.disconnect();
    nodeIO = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          const hit = nodeEls.find((n) => n.el === e.target);
          if (!hit) return;
          hit.node.classList.toggle("is-on", e.isIntersecting);
          hit.ring.classList.toggle("is-on", e.isIntersecting);
        });
      },
      { threshold: 0.25 }
    );
    sections.forEach((s) => nodeIO.observe(s));
  }

  // Pulso viajando pela parte já desenhada da rota.
  let t = 0;
  function frame() {
    if (comet && pathLen) {
      t = (t + 0.0016) % 1;
      const p = progress();
      const drawn = Math.max(1, pathLen * p);
      const pt = route.getPointAtLength(t * drawn);
      comet.setAttribute("cx", pt.x);
      comet.setAttribute("cy", pt.y);
      comet.style.opacity = p > 0.03 ? 1 : 0;
    }
    requestAnimationFrame(frame);
  }

  // Reconstrói quando o layout muda (fontes, iframes, resize).
  let rebuildTimer = null;
  function scheduleBuild() {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(build, 120);
  }

  build();
  if (!reduce) requestAnimationFrame(frame);

  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", scheduleBuild);
  window.addEventListener("load", scheduleBuild);
  // iframes das telas mudam a altura ao carregar/escalar.
  setTimeout(scheduleBuild, 600);
  setTimeout(scheduleBuild, 1600);
  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(scheduleBuild);
    ro.observe(document.body);
  }
})();
