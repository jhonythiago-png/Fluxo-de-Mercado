// Fluxo do Mercado - app do cliente
(function () {
  const sb = FM.sb;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const TELAS = ["carregando", "login", "termos", "bloqueio", "app"];

  let lic = null;            // resultado de minha_licenca()
  let usuarioId = null;
  let minhaSessao = null;
  let canal = null;
  let estados = {};          // ativo -> linha de estado_atual
  let eventos = [];          // eventos recentes (mais novo primeiro)
  let coletor = null;
  let filtro = "ambos";
  let abaAtual = "painel";
  const abertos = new Set(); // eventos expandidos
  const infosAbertas = new Set(); // explicações "?" abertas

  // Explicações curtas, sem revelar os indicadores por trás
  const INFOS = {
    referencia: "É o preço médio negociado no dia até agora. Acima dele, o lado comprador vem dominando o pregão; abaixo, o lado vendedor.",
    pressao: "Quem está agredindo agora: compras e vendas que foram executadas nos últimos minutos. É a medida que mais pesa na leitura.",
    forca: "Quem vem dominando nos últimos 30 minutos, considerando também onde o preço está em relação à referência do dia. Muda devagar e dá o contexto.",
    interesse: "O lado das ofertas que estão esperando para ser negociadas. São intenções, não negócios fechados, e podem ser retiradas a qualquer momento. Use só como contexto.",
  };
  function botaoInfo(chave, rotulo) {
    const aberto = infosAbertas.has(chave);
    return `<button type="button" class="info" data-info="${chave}" aria-expanded="${aberto}" aria-label="O que é ${rotulo}?">?</button>`;
  }
  function textoInfo(chave, tipo) {
    return infosAbertas.has(chave) ? `<p class="info-texto">${INFOS[tipo]}</p>` : "";
  }
  document.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-info]");
    if (!b) return;
    const chave = b.dataset.info;
    if (infosAbertas.has(chave)) infosAbertas.delete(chave); else infosAbertas.add(chave);
    renderAtivos();
    const novo = document.querySelector(`[data-info="${chave}"]`);
    if (novo) novo.focus();
  });
  let timerLicenca = null;
  let timerDados = null;
  let timerVigia = null;     // confere se o tempo real está chegando; se não, reconecta sozinho
  let timerReconexao = null;
  let tentativas = 0;
  let pedidoInstalar = null;

  const PREFERENCIAS = [
    ["estado", "Mudança de leitura do fluxo", "Quando WIN ou WDO muda de leitura"],
    ["reversao", "Possível reversão", "Sinais de exaustão depois de um movimento forte"],
    ["lado", "Preço mudando de lado", "Quando o preço troca de lado em relação à referência do dia"],
    ["cruzado", "WIN e WDO no mesmo sentido", "Quando os dois mostram fluxo na mesma direção"],
  ];

  function mostrar(tela) {
    TELAS.forEach((t) => (document.getElementById("tela-" + t).hidden = t !== tela));
  }

  if (!FM.configurado) {
    mostrar("login");
    $("#login-erro").textContent = "O app ainda não foi configurado: preencha o arquivo js/config.js.";
    $("#btn-entrar").disabled = true;
    return;
  }

  // ---------------- app instalável ----------------
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    pedidoInstalar = e;
    $("#btn-instalar").hidden = false;
  });
  $("#btn-instalar").addEventListener("click", async () => {
    if (!pedidoInstalar) return;
    pedidoInstalar.prompt();
    await pedidoInstalar.userChoice.catch(() => {});
    pedidoInstalar = null;
    $("#btn-instalar").hidden = true;
  });

  // ---------------- entrar / sair ----------------
  $$("[data-sair]").forEach((b) => b.addEventListener("click", () => sair()));

  function pararTudo() {
    fecharCanal();
    clearInterval(timerLicenca);
    clearInterval(timerDados);
    clearInterval(timerVigia);
    clearTimeout(timerReconexao);
    timerReconexao = null;
  }

  async function sair(mensagem) {
    pararTudo();
    await desativarPush();
    await sb.auth.signOut({ scope: "local" }).catch(() => {});
    lic = null;
    estados = {};
    eventos = [];
    mostrar("login");
    $("#login-erro").textContent = mensagem || "";
    $("#btn-entrar").disabled = false;
    $("#btn-entrar").textContent = "Entrar";
  }

  async function prepararLogin() {
    try {
      const { data } = await sb.rpc("contato_suporte");
      const link = FM.linkTelegram(data, "Olá! Preciso de ajuda com meu acesso ao Fluxo do Mercado.");
      const a = $("#link-suporte");
      if (link) a.href = link;
      else { a.removeAttribute("href"); a.textContent = "Fale com o suporte"; }
    } catch (e) { /* sem internet: segue */ }
  }

  $("#form-login").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const email = FM.emailDoUsuario($("#login-usuario").value);
    const senha = $("#login-senha").value;
    const erro = $("#login-erro");
    const botao = $("#btn-entrar");
    erro.textContent = "";
    if (!email || !senha) { erro.textContent = "Preencha usuário e senha."; return; }
    botao.disabled = true;
    botao.textContent = "Entrando…";
    try {
      const { data, error } = await sb.auth.signInWithPassword({ email, password: senha });
      if (error) throw error;
      const reg = await sb.rpc("registrar_sessao", { p_aparelho: FM.aparelho() });
      if (reg.error) throw reg.error;
      minhaSessao = FM.sessaoDoToken(data.session);
      usuarioId = data.user.id;
      $("#login-senha").value = "";
      await entrar();
    } catch (e) {
      erro.textContent = FM.erroAmigavel(e);
    } finally {
      botao.disabled = false;
      botao.textContent = "Entrar";
    }
  });

  async function iniciar() {
    prepararLogin();
    const { data } = await sb.auth.getSession();
    if (!data.session) { mostrar("login"); return; }
    minhaSessao = FM.sessaoDoToken(data.session);
    usuarioId = data.session.user.id;
    await entrar();
  }

  async function carregarLicenca() {
    const { data, error } = await sb.rpc("minha_licenca");
    if (error) throw error;
    if (!data) throw new Error("Perfil não encontrado. Fale com o suporte.");
    lic = data;
    lic.alertas = Object.assign({}, PADRAO_ALERTAS, data.alertas || {});
    return data;
  }

  async function entrar() {
    mostrar("carregando");
    try {
      await carregarLicenca();
    } catch (e) {
      await sair(FM.erroAmigavel(e));
      return;
    }
    avaliar();
  }

  function avaliar() {
    if (!lic.sessao_ok) return sessaoEncerrada();
    if (!lic.termos_ok && lic.papel !== "master") return mostrarTermos();
    if (["bloqueado", "suspenso", "sem_plano"].includes(lic.status)) return bloquear(lic.status);
    abrirApp();
  }

  function linkRenovar() {
    return FM.linkTelegram(lic && lic.telegram, FM.montarMensagem(lic && lic.mensagem_renovacao, {
      nome: lic && lic.nome, usuario: lic && lic.usuario, email: lic && lic.usuario, plano: (lic && lic.plano) || "",
    }));
  }

  function aplicarLinkRenovar(el) {
    const link = linkRenovar();
    if (link) { el.href = link; el.hidden = false; } else { el.hidden = true; }
  }

  // ---------------- termos ----------------
  function mostrarTermos() {
    $("#termos-texto").textContent = lic.termos_texto || "";
    mostrar("termos");
  }
  $("#btn-aceitar").addEventListener("click", async () => {
    const b = $("#btn-aceitar");
    b.disabled = true;
    const { error } = await sb.rpc("aceitar_termos");
    b.disabled = false;
    if (error) { FM.aviso(FM.erroAmigavel(error), "erro"); return; }
    await carregarLicenca();
    avaliar();
  });

  // ---------------- bloqueio ----------------
  function planosHtml() {
    return (lic.planos || []).map((p) => `
      <div class="cartao"><span class="rotulo">${FM.esc(p.nome)}</span>
      <span class="valor">${Number(p.valor) > 0 ? FM.moeda(p.valor) : "Consulte"}</span>
      <span class="sub">${p.dias} dias de acesso</span></div>`).join("");
  }

  function bloquear(tipo) {
    pararTudo();
    const textos = {
      bloqueado: ["Seu plano venceu", `O prazo para renovar terminou em ${FM.dataHora(lic.carencia_ate)}. Renove para voltar a acessar o painel.`],
      suspenso: ["Acesso suspenso", "Seu acesso foi suspenso. Fale com o suporte pelo Telegram."],
      sem_plano: ["Acesso ainda não liberado", "Escolha um plano e fale com o suporte para liberar seu acesso."],
    };
    const [titulo, texto] = textos[tipo] || textos.bloqueado;
    $("#bloqueio-email").textContent = lic.usuario ? "Usuário: " + lic.usuario : "";
    $("#bloqueio-titulo").textContent = titulo;
    $("#bloqueio-texto").textContent = texto;
    $("#bloqueio-planos").innerHTML = tipo === "suspenso" ? "" : planosHtml();
    const tg = $("#bloqueio-telegram");
    aplicarLinkRenovar(tg);
    tg.textContent = tipo === "suspenso" ? "Falar com o suporte" : "Renovar pelo Telegram";
    mostrar("bloqueio");
  }

  async function sessaoEncerrada() {
    await sair("Sua sessão foi encerrada porque a conta foi acessada em outro aparelho (é permitida uma sessão por vez). Entre de novo para continuar aqui.");
  }

  // ---------------- app ----------------
  function abrirApp() {
    mostrar("app");
    ativarPush(false);
    $("#btn-master").hidden = lic.papel !== "master";
    renderLegenda();
    renderFaixas();
    renderPreferencias();
    renderConta();
    trocarAba(abaAtual);
    carregarDados();
    assinar();
    clearInterval(timerLicenca);
    clearInterval(timerDados);
    clearInterval(timerVigia);
    timerLicenca = setInterval(revisarLicenca, 60000);
    timerDados = setInterval(atualizarStatusDados, 5000);
    timerVigia = setInterval(vigiar, 15000);
  }

  // ---------------- recuperação automática do tempo real ----------------
  function fecharCanal() {
    if (canal) {
      const velho = canal;
      canal = null;              // assim o aviso de "fechado" do canal velho é ignorado
      sb.removeChannel(velho);
    }
  }

  function agendarReconexao() {
    if (timerReconexao || !lic || $("#tela-app").hidden) return;
    tentativas += 1;
    const espera = Math.min(30000, 2000 * tentativas);   // 2s, 4s, 6s... até 30s
    timerReconexao = setTimeout(() => {
      timerReconexao = null;
      if (!lic || $("#tela-app").hidden) return;
      assinar();
      carregarDados();
    }, espera);
  }

  // A cada 15s confere no servidor se chegou dado novo que o tempo real não entregou.
  async function vigiar() {
    if (!lic || $("#tela-app").hidden || document.hidden) return;
    const { data, error } = await sb.from("coletor").select("*").eq("id", 1).maybeSingle();
    if (error || !data || !data.ultimo_envio) return;
    const servidor = new Date(data.ultimo_envio).getTime();
    const local = coletor && coletor.ultimo_envio ? new Date(coletor.ultimo_envio).getTime() : 0;
    if (servidor - local > 10000) {
      // o servidor está mais novo do que o que chegou aqui: a conexão caiu sem avisar
      assinar();
      await carregarDados();
    }
  }

  async function revisarLicenca() {
    try {
      await carregarLicenca();
    } catch (e) { return; }
    if (!lic.sessao_ok || (!lic.termos_ok && lic.papel !== "master") || ["bloqueado", "suspenso", "sem_plano"].includes(lic.status)) {
      avaliar();
      return;
    }
    renderFaixas();
    renderConta();
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && lic && !$("#tela-app").hidden) {
      revisarLicenca();
      carregarDados();
    }
  });

  sb.auth.onAuthStateChange((evento) => {
    if (evento === "SIGNED_OUT" && lic) { pararTudo(); lic = null; mostrar("login"); }
  });

  // abas
  $$("[data-aba]").forEach((b) => b.addEventListener("click", () => trocarAba(b.dataset.aba)));
  function trocarAba(aba) {
    abaAtual = aba;
    $$("[data-aba]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.aba === aba)));
    ["painel", "historico", "alertas", "conta"].forEach((a) => ($("#aba-" + a).hidden = a !== aba));
    if (aba === "historico") carregarHistorico();
    if (aba === "conta") carregarPagamentos();
  }

  // filtro de ativos
  $$("[data-filtro]").forEach((b) => b.addEventListener("click", () => {
    filtro = b.dataset.filtro;
    $$("[data-filtro]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.filtro === filtro)));
    renderAtivos();
  }));

  // ---------------- dados ----------------
  async function carregarDados() {
    const [e, ev, c] = await Promise.all([
      sb.from("estado_atual").select("*"),
      sb.from("eventos").select("*").order("criado_em", { ascending: false }).limit(80),
      sb.from("coletor").select("*").eq("id", 1).maybeSingle(),
    ]);
    estados = {};
    (e.data || []).forEach((r) => (estados[r.ativo] = r));
    eventos = ev.data || [];
    coletor = c.data || null;
    renderAtivos();
    renderCruzado();
    renderAlertasLista();
    atualizarStatusDados();
  }

  function assinar() {
    fecharCanal();
    const novo = sb
      .channel("fluxo-" + Math.random().toString(36).slice(2))
      .on("postgres_changes", { event: "*", schema: "public", table: "estado_atual" }, (p) => {
        const linha = p.new && p.new.ativo ? p.new : null;
        if (p.eventType === "DELETE" && p.old) delete estados[p.old.ativo];
        else if (linha) estados[linha.ativo] = linha;
        const ativo = (linha || p.old || {}).ativo;
        if (ativo === "CRUZADO") renderCruzado();
        else { renderAtivos(); renderCruzado(); }
      })
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "eventos" }, (p) => {
        eventos.unshift(p.new);
        eventos = eventos.slice(0, 120);
        renderAtivos();
        renderAlertasLista();
        notificar(p.new);
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "coletor" }, (p) => {
        if (p.new) { coletor = p.new; atualizarStatusDados(); }
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "perfis", filter: "id=eq." + usuarioId }, (p) => {
        if (lic && lic.papel !== "master" && p.new && p.new.sessao_atual !== minhaSessao) {
          sessaoEncerrada();
        } else {
          revisarLicenca();
        }
      })
      .subscribe((status) => {
        if (canal !== novo) return;              // canal antigo, já substituído
        if (status === "SUBSCRIBED") { tentativas = 0; return; }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") agendarReconexao();
      });
    canal = novo;
  }

  window.addEventListener("online", () => { if (lic && !$("#tela-app").hidden) { assinar(); carregarDados(); } });

  function atualizarStatusDados() {
    const ponto = $("#status-ponto");
    const texto = $("#status-texto");
    const faixa = $("#faixa-dados");
    const limite = (lic && lic.coletor_limite_seg) || 30;
    const ultimo = coletor && coletor.ultimo_envio;
    if (!ultimo) {
      ponto.className = "ponto off";
      texto.textContent = "Sem dados ainda";
      if (faixa) faixa.innerHTML = "";
      return;
    }
    const idade = (Date.now() - new Date(ultimo).getTime()) / 1000;
    if (idade <= limite) {
      ponto.className = "ponto vivo";
      texto.textContent = "Ao vivo, " + new Date(ultimo).toLocaleTimeString("pt-BR", { timeZone: FM.FUSO });
      if (faixa) faixa.innerHTML = "";
    } else {
      ponto.className = "ponto pausa";
      texto.textContent = "Dados pausados";
      if (faixa) {
        faixa.innerHTML = `<div class="faixa atencao"><span>Sem atualização desde ${FM.dataHora(ultimo)}. O painel mostra a última leitura recebida. Fora do horário de pregão isso é normal.</span></div>`;
      }
    }
  }

  // ---------------- faixas de aviso ----------------
  function renderFaixas() {
    const partes = [];
    if (lic.aviso_geral) partes.push(`<div class="faixa info"><span>${FM.esc(lic.aviso_geral)}</span></div>`);
    const link = linkRenovar();
    const botao = link ? `<a class="btn telegram pequeno" href="${FM.esc(link)}" target="_blank" rel="noopener">Renovar pelo Telegram</a>` : "";
    if (lic.status === "carencia") {
      partes.push(`<div class="faixa perigo" role="alert"><span><strong>Plano vencido em ${FM.data(lic.vence_em)}.</strong> Seu acesso será bloqueado em ${FM.dataHora(lic.carencia_ate)}. Renove agora para não perder o acesso.</span>${botao}</div>`);
    } else if (lic.status === "vencendo") {
      const d = Math.max(0, FM.diasAte(lic.vence_em));
      const quando = d === 0 ? "hoje" : d === 1 ? "amanhã" : `em ${d} dias`;
      partes.push(`<div class="faixa atencao"><span>Seu ${lic.teste ? "período de teste" : "plano"} vence ${quando}, ${FM.dataHora(lic.vence_em)}.</span>${botao}</div>`);
    } else if (lic.teste && lic.status === "ativo") {
      partes.push(`<div class="faixa info"><span>Você está no período de teste até ${FM.dataHora(lic.vence_em)}.</span>${botao}</div>`);
    }
    partes.push(`<div id="faixa-dados"></div>`);
    $("#faixas").innerHTML = partes.join("");
    atualizarStatusDados();
  }

  function renderLegenda() {
    $("#legenda").innerHTML = Object.values(FM.ESTADOS)
      .map((e) => `<span style="display:flex;align-items:center;gap:6px"><span class="ponto" style="background:${FM.TONS[e.tom]}"></span>${e.nome}</span>`)
      .join("");
  }

  // ---------------- cartões dos ativos ----------------
  function limitar(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function linhaTempo(lista, mostrarAtivo) {
    if (!lista.length) return `<p class="vazio">Nenhum acontecimento ainda.</p>`;
    return lista.map((e) => {
      const aberto = abertos.has(e.id);
      const quando = new Date(e.criado_em).toDateString() === new Date().toDateString() ? FM.hora(e.criado_em) : FM.data(e.criado_em).slice(0, 5);
      return `<div><button type="button" data-evento="${e.id}" aria-expanded="${aberto}">
        <span class="hora">${quando}</span>
        <span class="ponto" style="background:${FM.TONS[e.tom] || FM.TONS.neutro}"></span>
        <span style="flex:1;line-height:1.4">${mostrarAtivo ? `<strong>${FM.esc(e.ativo)}</strong>: ` : ""}${FM.esc(e.titulo)}</span>
        <span aria-hidden="true" class="sub" style="font-size:18px;width:16px;text-align:center">${e.detalhe ? (aberto ? "−" : "+") : ""}</span>
      </button>${aberto && e.detalhe ? `<p class="det">${FM.esc(e.detalhe)}</p>` : ""}</div>`;
    }).join("");
  }

  document.addEventListener("click", (ev) => {
    const b = ev.target.closest("[data-evento]");
    if (!b) return;
    const id = Number(b.dataset.evento);
    if (abertos.has(id)) abertos.delete(id); else abertos.add(id);
    renderAtivos();
    renderAlertasLista();
    const novo = document.querySelector(`[data-evento="${id}"]`);
    if (novo) novo.focus();
  });

  function cartaoAtivo(id) {
    const desc = { WIN: "Mini Índice", WDO: "Mini Dólar" }[id];
    const linha = estados[id];
    if (!linha) {
      return `<section class="pilha" aria-label="${id}"><div class="cartao"><div class="ativo-nome">${id}</div><span class="sub">${desc}</span><p class="vazio">Aguardando os primeiros dados.</p></div></section>`;
    }
    const d = linha.dados || {};
    const est = d.aquecendo ? { nome: "Aquecendo", tom: "neutro" } : (FM.ESTADOS[d.estado] || FM.ESTADOS.neutro);
    const cor = FM.TONS[est.tom];
    const posCor = d.posicao === "acima" ? "var(--compra)" : d.posicao === "abaixo" ? "var(--venda)" : "var(--sub)";
    const posTexto = d.posicao === "acima" ? "Acima da referência do dia" : d.posicao === "abaixo" ? "Abaixo da referência do dia" : "Na referência do dia";
    const conf = limitar(Math.round(Number(d.confianca) || 0), 0, 100);
    const ind = d.indices || {};
    const s = d.series || {};

    // ordem de importância: Pressão, Força, Interesse
    const indices = [["Pressão", ind.pressao, "pressao"], ["Força", ind.forca, "forca"], ["Interesse", ind.interesse, "interesse"]]
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([nome, v, tipo]) => {
        const p = limitar(Number(v), 0, 100);
        const chave = id + "-" + tipo;
        return `<div class="indice">
          <div class="linha-flex" style="font-size:13px"><span style="color:var(--texto2);font-weight:500;display:inline-flex;align-items:center;gap:6px">${nome} ${botaoInfo(chave, nome)}</span>
          <span><span style="color:var(--compra);font-weight:600">${FM.pct(p)} compra</span> <span class="sub">e</span> <span style="color:var(--venda);font-weight:600">${FM.pct(100 - p)} venda</span></span></div>
          ${textoInfo(chave, tipo)}
          <div class="barra-dupla" role="img" aria-label="${nome}: ${FM.pct(p)} do lado comprador"><div style="width:${p}%"></div></div>
        </div>`;
      }).join("");

    const pos = Array.isArray(s.posicao) ? s.posicao : [];
    const mPos = Math.max(1e-9, ...pos.map((v) => Math.abs(v)));
    const inter = Array.isArray(s.interesse) ? s.interesse : [];
    const mInt = Math.max(15, ...inter.map((v) => Math.abs(v - 50)));
    const evs = eventos.filter((e) => e.ativo === id).slice(0, 6);

    return `<section class="pilha" aria-label="${id}">
      <div class="cartao">
        <div class="ativo-topo">
          <div><div class="ativo-nome">${id}</div><span class="sub">${desc}</span></div>
          <div><div class="ativo-preco">${FM.numero(d.preco, id === "WDO" ? 1 : 0)}</div><div style="font-size:13px;font-weight:600;color:${posCor};display:flex;align-items:center;justify-content:flex-end;gap:6px">${posTexto} ${botaoInfo(id + "-referencia", "a referência do dia")}</div></div>
        </div>
        ${textoInfo(id + "-referencia", "referencia")}
        <div class="divisor"></div>
        <span class="rotulo">Estado do fluxo</span>
        <div class="estado"><span class="estado-ponto" style="background:${cor};box-shadow:0 0 0 6px color-mix(in srgb, ${cor} 18%, transparent)"></span><span class="estado-nome" style="color:${cor}">${est.nome}</span></div>
        ${!d.aquecendo && d.estado && d.estado !== "neutro" ? `<div class="confianca"><span class="sub" style="width:84px">Confiança</span><div class="barra"><div style="width:${conf}%;background:${cor}"></div></div><strong style="width:44px;text-align:right">${conf}%</strong></div>` : ""}
        ${d.frase ? `<p class="frase">${FM.esc(d.frase)}</p>` : ""}
      </div>
      <div class="cartao">
        <div class="linha-flex"><span class="rotulo">Fluxo do dia</span><span style="font-family:var(--titulo);font-size:22px;font-weight:700;color:${FM.TONS[d.fluxo_dia_tom] || "var(--texto)"}">${FM.esc((d.fluxo_dia || "—").replace(/^./, (c) => c.toUpperCase()))}</span></div>
        ${indices}
      </div>
      <div class="grade-2">
        <div class="mini"><strong>Fluxo por minuto</strong>${FM.svgBarras(s.fluxo_min)}<span class="sub">Últimos ${Array.isArray(s.fluxo_min) ? s.fluxo_min.length : 0} minutos</span></div>
        <div class="mini"><strong>Fluxo acumulado x preço</strong>${FM.svgLinhas([
          { valores: s.preco, cor: "#E9EDF4", opacidade: 0.55, espessura: 1.5 },
          { valores: s.fluxo_acum, cor: "#8B9CFF" },
        ])}<span class="sub"><span style="color:var(--acento);font-weight:600">Fluxo</span> e preço${d.acumulado_texto ? ": " + FM.esc(d.acumulado_texto) : ""}</span></div>
        <div class="mini"><strong>Posição do preço</strong>${FM.svgLinhas([{ valores: pos, cor: posCor, min: -mPos, max: mPos }], { referencia: 55 })}<span class="sub">Agora: <span style="color:${posCor};font-weight:600">${d.posicao || "—"}</span> da referência do dia</span></div>
        <div class="mini"><strong>Índice de interesse</strong>${FM.svgLinhas([{ valores: inter, cor: "#3DDC97", min: 50 - mInt, max: 50 + mInt }], { referencia: 55 })}<span class="sub">Agora: <span style="color:var(--texto);font-weight:600">${FM.pct(ind.interesse)}</span> do lado comprador</span></div>
      </div>
      <div class="cartao linha-tempo" style="padding-bottom:8px">
        <span class="rotulo" style="display:block;padding-bottom:6px">Linha do tempo</span>
        ${linhaTempo(evs, false)}
      </div>
    </section>`;
  }

  function renderAtivos() {
    const lista = ["WIN", "WDO"].filter((a) => filtro === "ambos" || filtro === a);
    $("#ativos").innerHTML = lista.map(cartaoAtivo).join("");
  }

  function renderCruzado() {
    const c = estados.CRUZADO && estados.CRUZADO.dados;
    const w = estados.WIN && estados.WIN.dados;
    const d = estados.WDO && estados.WDO.dados;
    if (!c && !w && !d) { $("#cruzado").innerHTML = `<p class="vazio">Aguardando os primeiros dados.</p>`; return; }
    const est = (x) => {
      if (!x) return "—";
      if (x.aquecendo) return `<span style="color:var(--neutro)">aquecendo</span>`;
      const e = FM.ESTADOS[x.estado] || FM.ESTADOS.neutro;
      return `<span style="color:${FM.TONS[e.tom]}">${e.nome.toLowerCase()}</span>`;
    };
    const fl = (x) => (x ? `<span style="color:${FM.TONS[x.fluxo_dia_tom] || "var(--texto)"}">${FM.esc(x.fluxo_dia || "—")}</span>` : "—");
    $("#cruzado").innerHTML = `
      <div class="grade-2">
        <div class="cartao" style="background:var(--painel2);border:0;padding:14px"><span class="sub">Fluxo do dia</span><div style="font-weight:600">WIN ${fl(w)}, WDO ${fl(d)}</div></div>
        <div class="cartao" style="background:var(--painel2);border:0;padding:14px"><span class="sub">Leitura atual</span><div style="font-weight:600">WIN ${est(w)}, WDO ${est(d)}</div></div>
      </div>
      ${c && c.texto ? `<p class="frase">${FM.esc(c.texto)}</p>` : ""}`;
  }

  // ---------------- alertas ----------------
  const PADRAO_ALERTAS = { estado: true, reversao: true, lado: false, cruzado: true, som: true, volume: 70 };
  let pushAtivo = false;     // este aparelho recebe alertas com o app fechado
  let ajudaAberta = false;

  function ehIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent); }
  function instalado() { return window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true; }
  function pushSuportado() { return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; }

  function renderPreferencias() {
    const pref = lic.alertas;
    const itens = PREFERENCIAS.map(([k, nome, desc]) => `
      <div class="item-alerta"><div style="min-width:0"><div style="font-weight:600">${nome}</div><div class="sub">${desc}</div></div>
      <button type="button" class="interruptor" data-pref="${k}" aria-pressed="${!!pref[k]}" aria-label="${nome}"><span></span></button></div>`).join("");
    const som = `
      <div class="item-alerta"><div style="min-width:0"><div style="font-weight:600">Som dos alertas</div><div class="sub">Um som diferente para cada tipo de leitura, com o app aberto</div></div>
      <button type="button" class="interruptor" data-pref="som" aria-pressed="${pref.som !== false}" aria-label="Som dos alertas"><span></span></button></div>
      <div class="item-alerta" style="border-top:0;padding-top:0">
        <label for="volume-alertas" class="sub" style="flex-shrink:0">Volume</label>
        <input id="volume-alertas" type="range" min="10" max="100" step="5" value="${pref.volume ?? 70}" style="flex:1;min-width:80px;accent-color:var(--acento-forte)">
        <button type="button" class="btn pequeno" id="btn-testar-som">Testar som</button>
      </div>`;
    $("#preferencias").innerHTML = itens + som + `<div id="ajuda-notificacoes"></div>`;
    atualizarBotaoNotificacao();
  }

  document.addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-pref]");
    if (!b) return;
    const k = b.dataset.pref;
    const novo = Object.assign({}, lic.alertas || {});
    novo[k] = !novo[k];
    b.setAttribute("aria-pressed", String(novo[k]));
    const { error } = await sb.rpc("salvar_alertas", { p_alertas: novo });
    if (error) { b.setAttribute("aria-pressed", String(!novo[k])); FM.aviso(FM.erroAmigavel(error), "erro"); return; }
    lic.alertas = novo;
    if (k === "som" && novo.som) tocarSom("compra", true);
  });

  document.addEventListener("input", (ev) => {
    if (ev.target.id === "volume-alertas" && lic) lic.alertas.volume = Number(ev.target.value);
  });
  document.addEventListener("change", async (ev) => {
    if (ev.target.id !== "volume-alertas" || !lic) return;
    tocarSom("compra", true);
    const { error } = await sb.rpc("salvar_alertas", { p_alertas: lic.alertas });
    if (error) FM.aviso(FM.erroAmigavel(error), "erro");
  });
  document.addEventListener("click", (ev) => {
    if (!ev.target.closest("#btn-testar-som")) return;
    tocarSom("compra", true);
    setTimeout(() => tocarSom("venda", true), 650);
    setTimeout(() => tocarSom("reversao", true), 1300);
  });

  // ---- som (gerado pelo próprio app, não depende do som de notificação do sistema)
  let audioCtx = null;
  function prepararAudio() {
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      if (!audioCtx) audioCtx = new AC();
      if (audioCtx.state === "suspended") audioCtx.resume();
    } catch (e) { /* sem áudio neste navegador */ }
  }
  // O navegador só libera o som depois de um toque ou clique na página
  document.addEventListener("pointerdown", prepararAudio, { passive: true });
  document.addEventListener("keydown", prepararAudio);

  // [frequência, atraso em segundos]: subindo = compra, descendo = venda, dois toques duplos = reversão
  const SONS = {
    compra: [[659, 0], [880, 0.14]],
    venda: [[880, 0], [659, 0.14]],
    absorcao: [[784, 0], [784, 0.16]],
    montando: [[587, 0], [784, 0.14]],
    reversao: [[740, 0], [988, 0.12], [740, 0.3], [988, 0.42]],
    neutro: [[660, 0]],
  };
  function tocarSom(tom, forcar) {
    const pref = (lic && lic.alertas) || PADRAO_ALERTAS;
    if (!forcar && pref.som === false) return;
    prepararAudio();
    if (!audioCtx || audioCtx.state !== "running") return;
    const vol = Math.max(0.05, Math.min(1, (pref.volume ?? 70) / 100)) * 0.35;
    const t0 = audioCtx.currentTime + 0.02;
    (SONS[tom] || SONS.neutro).forEach(([f, d]) => {
      [[f, 1], [f * 2, 0.18]].forEach(([freq, g]) => {
        const o = audioCtx.createOscillator();
        const ga = audioCtx.createGain();
        o.type = "sine";
        o.frequency.value = freq;
        ga.gain.setValueAtTime(0.0001, t0 + d);
        ga.gain.exponentialRampToValueAtTime(vol * g, t0 + d + 0.015);
        ga.gain.exponentialRampToValueAtTime(0.0001, t0 + d + 0.45);
        o.connect(ga).connect(audioCtx.destination);
        o.start(t0 + d);
        o.stop(t0 + d + 0.5);
      });
    });
  }

  // ---- notificação com o app fechado (Web Push)
  function chaveParaBytes(b64) {
    const p = "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob((b64 + p).replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  }

  async function ativarPush(avisar) {
    if (!lic || !lic.vapid_publica || !pushSuportado() || Notification.permission !== "granted") { atualizarBotaoNotificacao(); return; }
    try {
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: chaveParaBytes(lic.vapid_publica) });
      const j = sub.toJSON();
      const { error } = await sb.rpc("salvar_inscricao_push", {
        p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_aparelho: FM.aparelho(),
      });
      if (error) throw error;
      pushAtivo = true;
      if (avisar) FM.aviso("Pronto! Os alertas chegam neste aparelho mesmo com o app fechado.", "ok");
    } catch (e) {
      pushAtivo = false;
      if (avisar) FM.aviso("Não consegui ativar as notificações neste aparelho. " + FM.erroAmigavel(e), "erro");
    }
    atualizarBotaoNotificacao();
  }

  async function desativarPush() {
    try {
      if (!pushSuportado()) return;
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg && (await reg.pushManager.getSubscription());
      if (sub) {
        await sb.rpc("remover_inscricao_push", { p_endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
    } catch (e) { /* segue saindo */ }
    pushAtivo = false;
  }

  const AJUDA_NOTIFICACOES = `<div class="info-texto">
    <strong>Como liberar as notificações</strong><br>
    <strong>No computador (Chrome ou Edge):</strong> clique no ícone à esquerda do endereço do site, em Notificações escolha Permitir e recarregue a página.<br>
    <strong>No Android:</strong> toque nos três pontinhos, depois no ícone de informações do site, em Permissões e em Notificações: Permitir.<br>
    <strong>No iPhone:</strong> instale o app na tela inicial (Compartilhar, Adicionar à Tela de Início) e abra por ele. Precisa do iOS 16.4 ou mais novo.<br>
    Para ouvir o som com o app fechado, deixe o som de notificações ligado no Windows ou no celular.</div>`;

  function atualizarBotaoNotificacao() {
    const b = $("#btn-notificacoes");
    const ajuda = $("#ajuda-notificacoes");
    if (!b) return;
    if (!("Notification" in window)) {
      b.hidden = true;
      if (ajuda) ajuda.innerHTML = ehIOS() && !instalado()
        ? `<p class="info-texto">No iPhone, as notificações só funcionam com o app instalado na tela inicial: toque em Compartilhar e depois em "Adicionar à Tela de Início".</p>` : "";
      return;
    }
    b.hidden = false;
    const perm = Notification.permission;
    if (perm === "granted") {
      const podePush = !!(lic && lic.vapid_publica) && pushSuportado();
      b.textContent = pushAtivo || !podePush ? "Notificações ativas" : "Ativar com o app fechado";
      b.disabled = pushAtivo || !podePush;
    } else if (perm === "denied") {
      b.textContent = ajudaAberta ? "Fechar ajuda" : "Como liberar as notificações";
      b.disabled = false;
    } else {
      b.textContent = "Ativar notificações";
      b.disabled = false;
    }
    if (ajuda) {
      if (perm === "denied" && ajudaAberta) ajuda.innerHTML = AJUDA_NOTIFICACOES;
      else if (pushAtivo) ajuda.innerHTML = `<p class="sub" style="margin:10px 0 0">Os alertas ligados acima chegam neste aparelho mesmo com o app fechado.</p>`;
      else ajuda.innerHTML = "";
    }
  }

  $("#btn-notificacoes").addEventListener("click", async () => {
    prepararAudio();
    if ("Notification" in window && Notification.permission === "denied") {
      ajudaAberta = !ajudaAberta;
      atualizarBotaoNotificacao();
      return;
    }
    try { if (Notification.permission !== "granted") await Notification.requestPermission(); } catch (e) { /* ignora */ }
    if (Notification.permission === "granted") await ativarPush(true);
    atualizarBotaoNotificacao();
  });

  function notificar(ev) {
    if (!lic || !(lic.alertas || {})[ev.categoria]) return;
    const texto = `${ev.ativo}: ${ev.titulo}`;
    FM.aviso(texto);
    tocarSom(ev.tom);
    // Com o envio pelo servidor ativo, a notificação do sistema já chega por lá (sem duplicar)
    if (pushAtivo) return;
    if (!("Notification" in window) || Notification.permission !== "granted" || !document.hidden) return;
    const opcoes = { body: texto, icon: "icones/icone-192.png", badge: "icones/icone-192.png", tag: "evento-" + ev.id, silent: true };
    if (navigator.serviceWorker && navigator.serviceWorker.ready) {
      navigator.serviceWorker.ready.then((reg) => reg.showNotification("Fluxo do Mercado", opcoes)).catch(() => {
        try { new Notification("Fluxo do Mercado", opcoes); } catch (e) { /* ignora */ }
      });
    } else {
      try { new Notification("Fluxo do Mercado", opcoes); } catch (e) { /* ignora */ }
    }
  }

  function renderAlertasLista() {
    $("#alertas-lista").innerHTML = linhaTempo(eventos.slice(0, 80), true);
  }

  // ---------------- histórico ----------------
  async function carregarHistorico() {
    const corpo = $("#historico-linhas");
    corpo.innerHTML = `<tr><td colspan="7" class="vazio">Carregando…</td></tr>`;
    const { data, error } = await sb.from("sinais").select("*").order("criado_em", { ascending: false }).limit(300);
    if (error) { corpo.innerHTML = `<tr><td colspan="7" class="vazio">${FM.esc(FM.erroAmigavel(error))}</td></tr>`; return; }
    const lista = data || [];
    const avaliados = lista.filter((s) => s.resultado);
    const conf = avaliados.filter((s) => s.resultado === "confirmou").length;
    const nao = avaliados.filter((s) => s.resultado === "nao_confirmou").length;
    const pcent = (n) => (avaliados.length ? FM.pct((n / avaliados.length) * 100) : "—");
    $("#historico-resumo").innerHTML = `
      <div class="cartao"><span class="rotulo">Leituras registradas</span><span class="valor">${lista.length}</span></div>
      <div class="cartao"><span class="rotulo">Confirmaram</span><span class="valor" style="color:var(--compra)">${pcent(conf)}</span><span class="sub">${conf} de ${avaliados.length} avaliadas</span></div>
      <div class="cartao"><span class="rotulo">Não confirmaram</span><span class="valor" style="color:var(--venda)">${pcent(nao)}</span><span class="sub">${nao} de ${avaliados.length} avaliadas</span></div>`;
    if (!lista.length) { corpo.innerHTML = `<tr><td colspan="7" class="vazio">Nenhuma leitura registrada ainda.</td></tr>`; return; }
    const RES = { confirmou: "Confirmou", nao_confirmou: "Não confirmou", neutro: "Neutro" };
    corpo.innerHTML = lista.map((s) => {
      const e = FM.ESTADOS[s.estado] || { nome: s.estado, tom: "neutro" };
      return `<tr>
        <td class="sub">${FM.dataHora(s.criado_em)}</td>
        <td style="font-weight:600">${FM.esc(s.ativo)}</td>
        <td><span style="display:inline-flex;align-items:center;gap:8px"><span class="ponto" style="background:${FM.TONS[e.tom]}"></span>${FM.esc(e.nome)}</span></td>
        <td>${s.confianca == null ? "—" : s.confianca + "%"}</td>
        <td>${FM.numero(s.preco, s.ativo === "WDO" ? 1 : 0)}</td>
        <td>${FM.numero(s.preco_depois, s.ativo === "WDO" ? 1 : 0)}</td>
        <td>${s.resultado ? `<span class="chip ${s.resultado}">${RES[s.resultado]}</span>` : `<span class="sub">aguardando</span>`}</td>
      </tr>`;
    }).join("");
  }

  // ---------------- conta ----------------
  function renderConta() {
    const st = FM.STATUS[lic.status] || FM.STATUS.sem_plano;
    $("#conta-resumo").innerHTML = `
      <div class="cartao"><span class="rotulo">Situação</span><span><span class="chip ${st.classe}">${st.nome}</span>${lic.teste ? ' <span class="chip teste">Teste</span>' : ""}</span><span class="sub">Usuário: ${FM.esc(lic.usuario || "")}</span></div>
      <div class="cartao"><span class="rotulo">Plano</span><span class="valor" style="font-size:22px">${FM.esc(lic.plano || (lic.teste ? "Teste" : "—"))}</span></div>
      <div class="cartao"><span class="rotulo">Válido até</span><span class="valor" style="font-size:22px">${FM.data(lic.vence_em)}</span><span class="sub">${lic.vence_em ? FM.hora(lic.vence_em) : ""}</span></div>
      <div class="cartao"><span class="rotulo">Prazo final para renovar</span><span class="valor" style="font-size:22px">${FM.data(lic.carencia_ate)}</span><span class="sub">depois disso o acesso é bloqueado</span></div>`;
    $("#conta-planos").innerHTML = planosHtml() || `<p class="vazio">Fale com o suporte.</p>`;
    aplicarLinkRenovar($("#conta-telegram"));
  }

  async function carregarPagamentos() {
    const corpo = $("#conta-pagamentos");
    const { data, error } = await sb.from("pagamentos").select("criado_em, plano_nome, valor, vence_depois").order("criado_em", { ascending: false }).limit(50);
    if (error) { corpo.innerHTML = `<tr><td colspan="4" class="vazio">${FM.esc(FM.erroAmigavel(error))}</td></tr>`; return; }
    if (!data || !data.length) { corpo.innerHTML = `<tr><td colspan="4" class="vazio">Nenhum pagamento registrado.</td></tr>`; return; }
    corpo.innerHTML = data.map((p) => `<tr><td>${FM.data(p.criado_em)}</td><td>${FM.esc(p.plano_nome)}</td><td>${FM.moeda(p.valor)}</td><td>${FM.data(p.vence_depois)}</td></tr>`).join("");
  }

  iniciar();
})();
