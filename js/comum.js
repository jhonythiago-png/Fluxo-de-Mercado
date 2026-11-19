// Fluxo do Mercado - funções comuns ao app e ao master
(function () {
  const cfg = window.FM_CONFIG || {};
  const configurado = cfg.SUPABASE_URL && !cfg.SUPABASE_URL.startsWith("COLE_AQUI");

  const sb = configurado
    ? window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: "fluxo-do-mercado-auth" },
      })
    : null;

  const FUSO = "America/Sao_Paulo";

  const STATUS = {
    master: { nome: "Master", classe: "master" },
    ativo: { nome: "Ativo", classe: "ativo" },
    vencendo: { nome: "Vencendo", classe: "vencendo" },
    carencia: { nome: "Em carência", classe: "carencia" },
    bloqueado: { nome: "Bloqueado", classe: "bloqueado" },
    suspenso: { nome: "Suspenso", classe: "suspenso" },
    sem_plano: { nome: "Sem plano", classe: "sem_plano" },
  };

  const TONS = {
    compra: "var(--compra)",
    venda: "var(--venda)",
    absorcao: "var(--absorcao)",
    montando: "var(--montando)",
    reversao: "var(--reversao)",
    neutro: "var(--neutro)",
  };

  const ESTADOS = {
    comprando: { nome: "Comprando", tom: "compra" },
    vendendo: { nome: "Vendendo", tom: "venda" },
    absorcao: { nome: "Absorção", tom: "absorcao" },
    montando: { nome: "Montando posição", tom: "montando" },
    reversao: { nome: "Possível reversão", tom: "reversao" },
    neutro: { nome: "Neutro", tom: "neutro" },
  };

  function esc(v) {
    return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function data(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleDateString("pt-BR", { timeZone: FUSO });
  }
  function dataHora(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleString("pt-BR", { timeZone: FUSO, day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }
  function hora(iso) {
    if (!iso) return "—";
    return new Date(iso).toLocaleTimeString("pt-BR", { timeZone: FUSO, hour: "2-digit", minute: "2-digit" });
  }
  function moeda(v) {
    return Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
  }
  function numero(v, casas) {
    if (v === null || v === undefined || v === "" || isNaN(Number(v))) return "—";
    const n = Number(v);
    const c = casas ?? (Number.isInteger(n) ? 0 : 2);
    return n.toLocaleString("pt-BR", { minimumFractionDigits: c, maximumFractionDigits: c });
  }
  function pct(v) {
    if (v === null || v === undefined || isNaN(Number(v))) return "—";
    return Number(v).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + "%";
  }
  function diasAte(iso) {
    if (!iso) return null;
    return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
  }

  // Lê o session_id de dentro do token de acesso (usado para a regra de uma sessão por vez)
  function sessaoDoToken(session) {
    try {
      const parte = session.access_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
      const json = JSON.parse(decodeURIComponent(escape(atob(parte + "===".slice((parte.length + 3) % 4)))));
      return json.session_id || null;
    } catch (e) {
      return null;
    }
  }

  function aparelho() {
    const ua = navigator.userAgent;
    let nav = "Navegador";
    if (/Edg\//.test(ua)) nav = "Edge";
    else if (/OPR\//.test(ua)) nav = "Opera";
    else if (/Chrome\//.test(ua)) nav = "Chrome";
    else if (/Firefox\//.test(ua)) nav = "Firefox";
    else if (/Safari\//.test(ua)) nav = "Safari";
    let so = "";
    if (/Windows/.test(ua)) so = "Windows";
    else if (/Android/.test(ua)) so = "Android";
    else if (/iPhone|iPad/.test(ua)) so = "iPhone/iPad";
    else if (/Mac OS/.test(ua)) so = "Mac";
    else if (/Linux/.test(ua)) so = "Linux";
    const app = window.matchMedia("(display-mode: standalone)").matches ? " (app instalado)" : "";
    return `${nav}${so ? " no " + so : ""}${app}`;
  }

  function linkTelegram(usuario, mensagem) {
    const u = String(usuario || "").trim().replace(/^@/, "").replace(/^https?:\/\/t\.me\//, "");
    if (!u) return null;
    return `https://t.me/${encodeURIComponent(u)}${mensagem ? "?text=" + encodeURIComponent(mensagem) : ""}`;
  }

  function montarMensagem(modelo, dados) {
    return String(modelo || "").replace(/\{(\w+)\}/g, (_, k) => (dados && dados[k] != null ? dados[k] : ""));
  }

  function aviso(texto, tipo) {
    let caixa = document.getElementById("avisos");
    if (!caixa) {
      caixa = document.createElement("div");
      caixa.id = "avisos";
      caixa.setAttribute("role", "status");
      caixa.setAttribute("aria-live", "polite");
      document.body.appendChild(caixa);
    }
    const el = document.createElement("div");
    el.className = "aviso-flutuante" + (tipo ? " " + tipo : "");
    el.textContent = texto;
    caixa.appendChild(el);
    setTimeout(() => el.remove(), tipo === "erro" ? 7000 : 4500);
  }

  function erroAmigavel(e) {
    const m = (e && (e.message || e.error_description || e.erro)) || String(e || "");
    if (/Invalid login credentials/i.test(m)) return "E-mail ou senha incorretos.";
    if (/Email not confirmed/i.test(m)) return "E-mail ainda não confirmado.";
    if (/Failed to fetch|NetworkError/i.test(m)) return "Sem conexão com o servidor. Confira sua internet.";
    if (/already been registered|already registered/i.test(m)) return "Já existe um usuário com esse e-mail.";
    return m || "Algo deu errado.";
  }

  // Desenho dos gráficos pequenos (SVG 300x110)
  function pontos(arr, min, max) {
    const lo = min ?? Math.min(...arr);
    const hi = max ?? Math.max(...arr);
    const span = hi - lo || 1;
    return arr.map((v, i) => `${((i / Math.max(arr.length - 1, 1)) * 300).toFixed(1)},${(8 + (1 - (v - lo) / span) * 94).toFixed(1)}`).join(" ");
  }
  function svgBarras(valores) {
    if (!Array.isArray(valores) || valores.length === 0) return svgVazio();
    const n = valores.length;
    const larg = 300 / n;
    const m = Math.max(...valores.map((v) => Math.abs(v))) || 1;
    const barras = valores
      .map((v, i) => {
        const h = Math.max(1.5, (Math.abs(v) / m) * 48);
        const y = v >= 0 ? 55 - h : 55;
        return `<rect x="${(i * larg + larg * 0.15).toFixed(1)}" y="${y.toFixed(1)}" width="${(larg * 0.7).toFixed(1)}" height="${h.toFixed(1)}" rx="1.5" fill="${v >= 0 ? "#3DDC97" : "#FF6B6B"}"></rect>`;
      })
      .join("");
    return `<svg viewBox="0 0 300 110" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="55" x2="300" y2="55" stroke="#2A3242"></line>${barras}</svg>`;
  }
  function svgLinhas(linhas, opcoes) {
    const validas = linhas.filter((l) => Array.isArray(l.valores) && l.valores.length > 1);
    if (validas.length === 0) return svgVazio();
    const ref = opcoes && opcoes.referencia !== undefined
      ? `<line x1="0" y1="${opcoes.referencia}" x2="300" y2="${opcoes.referencia}" stroke="#4A5468" stroke-dasharray="4 4" vector-effect="non-scaling-stroke"></line>`
      : "";
    const polys = validas
      .map((l) => `<polyline points="${pontos(l.valores, l.min, l.max)}" fill="none" stroke="${l.cor}" stroke-width="${l.espessura || 2}" stroke-opacity="${l.opacidade || 1}" vector-effect="non-scaling-stroke"></polyline>`)
      .join("");
    return `<svg viewBox="0 0 300 110" preserveAspectRatio="none" aria-hidden="true">${ref}${polys}</svg>`;
  }
  function svgVazio() {
    return `<svg viewBox="0 0 300 110" preserveAspectRatio="none" aria-hidden="true"><line x1="0" y1="55" x2="300" y2="55" stroke="#2A3242" stroke-dasharray="4 4"></line></svg>`;
  }

  window.FM = {
    sb, configurado, STATUS, TONS, ESTADOS, FUSO,
    esc, data, dataHora, hora, moeda, numero, pct, diasAte,
    sessaoDoToken, aparelho, linkTelegram, montarMensagem, aviso, erroAmigavel,
    svgBarras, svgLinhas, svgVazio,
  };
})();
