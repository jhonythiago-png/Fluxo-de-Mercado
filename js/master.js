// Fluxo do Mercado - painel master
(function () {
  const sb = FM.sb;
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const TELAS = ["carregando", "login", "negado", "master"];

  let usuarios = [];
  let planos = [];
  let config = null;
  let resumo = null;
  let atual = null; // usuário aberto no diálogo
  let timer = null;

  function mostrar(tela) {
    TELAS.forEach((t) => (document.getElementById("tela-" + t).hidden = t !== tela));
  }

  if (!FM.configurado) {
    mostrar("login");
    $("#login-erro").textContent = "Preencha o arquivo js/config.js com os dados do Supabase.";
    $("#btn-entrar").disabled = true;
    return;
  }

  // ---------------- entrar / sair ----------------
  $$("[data-sair]").forEach((b) => b.addEventListener("click", async () => {
    clearInterval(timer);
    await sb.auth.signOut({ scope: "local" }).catch(() => {});
    mostrar("login");
  }));

  $("#form-login").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const erro = $("#login-erro");
    const botao = $("#btn-entrar");
    erro.textContent = "";
    const email = FM.emailDoUsuario($("#login-usuario").value);
    const senha = $("#login-senha").value;
    if (!email || !senha) { erro.textContent = "Preencha usuário e senha."; return; }
    botao.disabled = true;
    botao.textContent = "Entrando…";
    try {
      const { error } = await sb.auth.signInWithPassword({ email, password: senha });
      if (error) throw error;
      await sb.rpc("registrar_sessao", { p_aparelho: "Master: " + FM.aparelho() });
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
    const { data } = await sb.auth.getSession();
    if (!data.session) { mostrar("login"); return; }
    await entrar();
  }

  async function entrar() {
    mostrar("carregando");
    const { data, error } = await sb.rpc("minha_licenca");
    if (error || !data) { mostrar("login"); $("#login-erro").textContent = FM.erroAmigavel(error || "Perfil não encontrado."); return; }
    if (data.papel !== "master") { mostrar("negado"); return; }
    mostrar("master");
    await recarregarTudo();
    clearInterval(timer);
    timer = setInterval(() => { carregarResumo(); }, 30000);
  }

  async function recarregarTudo() {
    await Promise.all([carregarConfig(), carregarPlanos()]);
    await Promise.all([carregarResumo(), carregarUsuarios()]);
  }

  // ---------------- abas ----------------
  $$("[data-aba]").forEach((b) => b.addEventListener("click", () => {
    const aba = b.dataset.aba;
    $$("[data-aba]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.aba === aba)));
    ["geral", "usuarios", "planos", "config", "acessos"].forEach((a) => ($("#aba-" + a).hidden = a !== aba));
    if (aba === "acessos") carregarAcessos();
    if (aba === "geral") carregarResumo();
  }));

  // ---------------- utilidades ----------------
  function chipStatus(u) {
    const st = FM.STATUS[u.status] || FM.STATUS.sem_plano;
    return `<span class="chip ${st.classe}">${st.nome}</span>${u.teste && ["ativo", "vencendo", "carencia"].includes(u.status) ? ' <span class="chip teste">Teste</span>' : ""}`;
  }

  function linkCobranca(u) {
    const msg = `Olá ${u.nome || ""}! Seu acesso ao Fluxo do Mercado ${u.status === "bloqueado" ? "venceu" : "vence"} em ${FM.data(u.vence_em)}. Quer renovar?`;
    return FM.linkTelegram(u.telegram, msg);
  }

  async function chamar(rpc, args, okMsg) {
    const { data, error } = await sb.rpc(rpc, args);
    if (error) { FM.aviso(FM.erroAmigavel(error), "erro"); throw error; }
    if (okMsg) FM.aviso(okMsg, "ok");
    return data;
  }

  function paraInputData(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ---------------- visão geral ----------------
  async function carregarResumo() {
    const { data, error } = await sb.rpc("master_resumo");
    if (error) { FM.aviso(FM.erroAmigavel(error), "erro"); return; }
    resumo = data;
    const cartao = (rotulo, valor, sub, cor) =>
      `<div class="cartao"><span class="rotulo">${rotulo}</span><span class="valor"${cor ? ` style="color:${cor}"` : ""}>${valor}</span>${sub ? `<span class="sub">${sub}</span>` : ""}</div>`;
    $("#resumo").innerHTML = [
      cartao("Ativos", data.ativos, `${data.total} clientes no total`, "var(--compra)"),
      cartao("Vencendo", data.vencendo, `${data.vence_7d} vencem nos próximos 7 dias`, "var(--absorcao)"),
      cartao("Em carência", data.carencia, "já venceram, ainda acessam", "#FFB38A"),
      cartao("Bloqueados", data.bloqueados, `${data.suspensos} suspensos`, "var(--venda)"),
      cartao("Em teste", data.em_teste, `${data.sem_plano} sem plano`),
      cartao("Receita do mês", FM.moeda(data.receita_mes), `${data.pagamentos_mes} pagamentos`, "var(--acento)"),
    ].join("");
    atualizarColetor();
    renderAtencao();
  }

  function atualizarColetor() {
    if (!resumo) return;
    const ultimo = resumo.coletor_ultimo_envio;
    const limite = resumo.coletor_limite_seg || 30;
    const ponto = $("#coletor-ponto");
    const texto = $("#coletor-texto");
    const faixa = $("#coletor-faixa");
    if (!ultimo) {
      ponto.className = "ponto off";
      texto.textContent = "Coletor nunca enviou dados. Ligue o calculador no seu PC.";
      faixa.className = "faixa perigo";
      return;
    }
    const idade = (Date.now() - new Date(ultimo).getTime()) / 1000;
    if (idade <= limite) {
      ponto.className = "ponto vivo";
      texto.textContent = `Coletor enviando dados (último envio às ${new Date(ultimo).toLocaleTimeString("pt-BR", { timeZone: FM.FUSO })})`;
      faixa.className = "faixa";
    } else {
      ponto.className = "ponto pausa";
      texto.textContent = `Coletor parado desde ${FM.dataHora(ultimo)}. Os clientes veem "dados pausados".`;
      faixa.className = "faixa atencao";
    }
  }

  function renderAtencao() {
    const lista = usuarios
      .filter((u) => u.papel === "cliente" && (["vencendo", "carencia"].includes(u.status) ||
        (u.status === "bloqueado" && u.vence_em && Date.now() - new Date(u.vence_em).getTime() < 15 * 86400000)))
      .sort((a, b) => new Date(a.vence_em) - new Date(b.vence_em));
    if (!lista.length) { $("#atencao").innerHTML = `<tr><td colspan="5" class="vazio">Ninguém precisa de atenção agora.</td></tr>`; return; }
    $("#atencao").innerHTML = lista.map((u) => {
      const tg = linkCobranca(u);
      return `<tr>
        <td><strong>${FM.esc(u.nome || "—")}</strong><div class="sub">usuário: ${FM.esc(u.usuario)}</div></td>
        <td>${chipStatus(u)}</td>
        <td>${FM.dataHora(u.vence_em)}</td>
        <td>${tg ? `<a class="btn pequeno telegram" href="${FM.esc(tg)}" target="_blank" rel="noopener">Telegram</a>` : `<span class="sub">${FM.esc(u.telefone || "sem contato")}</span>`}</td>
        <td><button class="btn pequeno" type="button" data-abrir="${u.id}">Renovar</button></td>
      </tr>`;
    }).join("");
  }

  // ---------------- usuários ----------------
  async function carregarUsuarios() {
    const { data, error } = await sb.rpc("master_listar_usuarios");
    if (error) { FM.aviso(FM.erroAmigavel(error), "erro"); return; }
    usuarios = data || [];
    renderUsuarios();
    renderAtencao();
    if (atual) {
      const novo = usuarios.find((u) => u.id === atual.id);
      if (novo) { atual = novo; preencherUsuario(); }
    }
  }

  $("#busca").addEventListener("input", renderUsuarios);
  $("#filtro-status").addEventListener("change", renderUsuarios);

  function renderUsuarios() {
    const busca = $("#busca").value.trim().toLowerCase();
    const filtro = $("#filtro-status").value;
    const lista = usuarios.filter((u) => {
      if (filtro === "teste" && !(u.teste && ["ativo", "vencendo", "carencia"].includes(u.status))) return false;
      if (filtro && filtro !== "teste" && u.status !== filtro) return false;
      if (busca && ![u.nome, u.usuario, u.telefone, u.telegram].join(" ").toLowerCase().includes(busca)) return false;
      return true;
    });
    if (!lista.length) { $("#usuarios").innerHTML = `<tr><td colspan="6" class="vazio">Nenhum usuário encontrado.</td></tr>`; return; }
    $("#usuarios").innerHTML = lista.map((u) => `
      <tr class="clicavel" data-abrir="${u.id}" tabindex="0">
        <td><strong>${FM.esc(u.nome || "—")}</strong><div class="sub">usuário: ${FM.esc(u.usuario)}</div></td>
        <td>${chipStatus(u)}</td>
        <td>${FM.esc(u.plano_nome || (u.teste ? "Teste" : "—"))}</td>
        <td>${FM.dataHora(u.vence_em)}</td>
        <td class="sub">${FM.dataHora(u.ultimo_acesso)}</td>
        <td>${FM.moeda(u.total_pago)}</td>
      </tr>`).join("");
  }

  document.addEventListener("click", (ev) => {
    const el = ev.target.closest("[data-abrir]");
    if (el) abrirUsuario(el.dataset.abrir);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    const el = ev.target.closest && ev.target.closest("tr[data-abrir]");
    if (el) abrirUsuario(el.dataset.abrir);
  });

  // ---------------- diálogo do usuário ----------------
  $$("[data-fechar]").forEach((b) => b.addEventListener("click", () => b.closest("dialog").close()));
  $("#dlg-usuario").addEventListener("close", () => { atual = null; });

  function abrirUsuario(id) {
    atual = usuarios.find((u) => u.id === id);
    if (!atual) return;
    $("#ren-plano").innerHTML = planos.filter((p) => p.ativo).map((p) => `<option value="${p.id}">${FM.esc(p.nome)} (${p.dias} dias)</option>`).join("");
    if (atual.plano_id && planos.some((p) => p.id === atual.plano_id && p.ativo)) $("#ren-plano").value = atual.plano_id;
    $("#ren-obs").value = "";
    $("#ren-forma").value = "PIX";
    atualizarValorPlano();
    preencherUsuario();
    carregarPagamentosUsuario();
    $("#dlg-usuario").showModal();
  }

  function preencherUsuario() {
    const u = atual;
    $("#usr-titulo").textContent = u.nome || u.usuario;
    $("#usr-email").textContent = "usuário: " + (u.usuario || "");
    const carenciaAte = u.vence_em ? new Date(new Date(u.vence_em).getTime() + config.dias_carencia * 86400000).toISOString() : null;
    $("#usr-resumo").innerHTML = `
      <div class="cartao"><span class="rotulo">Situação</span><span>${chipStatus(u)}</span></div>
      <div class="cartao"><span class="rotulo">Vence em</span><strong>${FM.dataHora(u.vence_em)}</strong><span class="sub">bloqueia em ${FM.dataHora(carenciaAte)}</span></div>
      <div class="cartao"><span class="rotulo">Último acesso</span><strong>${FM.dataHora(u.ultimo_acesso)}</strong><span class="sub">${u.sessao_ativa ? "conectado em um aparelho" : "nenhum aparelho conectado"}</span></div>
      <div class="cartao"><span class="rotulo">Total pago</span><strong>${FM.moeda(u.total_pago)}</strong><span class="sub">cliente desde ${FM.data(u.criado_em)}</span></div>`;
    $("#usr-nome").value = u.nome || "";
    $("#usr-telefone").value = u.telefone || "";
    $("#usr-tg").value = u.telegram || "";
    $("#usr-obs").value = u.observacao || "";
    $("#usr-vence").value = paraInputData(u.vence_em);
    $("#usr-suspender").textContent = u.suspenso ? "Reativar" : "Suspender";
    const ehMaster = u.papel === "master";
    ["#usr-teste", "#usr-sessao", "#usr-suspender", "#usr-excluir"].forEach((s) => ($(s).hidden = ehMaster));
    $("#form-renovar").hidden = ehMaster;
    const tg = linkCobranca(u);
    const a = $("#usr-telegram");
    if (tg) { a.href = tg; a.hidden = false; } else a.hidden = true;
    atualizarPrevia();
  }

  function atualizarValorPlano() {
    const p = planos.find((x) => x.id === $("#ren-plano").value);
    $("#ren-valor").value = p ? Number(p.valor).toFixed(2) : "";
    atualizarPrevia();
  }
  $("#ren-plano").addEventListener("change", atualizarValorPlano);

  // Mesma regra do banco: dentro do prazo soma a partir do vencimento antigo; depois, a partir de agora
  function atualizarPrevia() {
    if (!atual || !config) return;
    const p = planos.find((x) => x.id === $("#ren-plano").value);
    if (!p) { $("#ren-previa").textContent = "Cadastre um plano ativo na aba Planos."; return; }
    const agora = Date.now();
    const vence = atual.vence_em ? new Date(atual.vence_em).getTime() : null;
    const dentro = vence !== null && agora <= vence + config.dias_carencia * 86400000;
    const base = dentro ? vence : agora;
    const novo = new Date(base + p.dias * 86400000);
    $("#ren-previa").textContent = `Novo vencimento: ${FM.dataHora(novo.toISOString())} (${dentro ? "somado ao vencimento atual" : "a partir de hoje"})`;
  }

  $("#form-renovar").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const plano = $("#ren-plano").value;
    if (!plano) return;
    const valor = $("#ren-valor").value === "" ? null : Number($("#ren-valor").value);
    const r = await chamar("master_renovar", { p_usuario: atual.id, p_plano: plano, p_valor: valor, p_forma: $("#ren-forma").value, p_obs: $("#ren-obs").value }).catch(() => null);
    if (!r) return;
    FM.aviso(`Renovado até ${FM.dataHora(r.vence_em)}`, "ok");
    await Promise.all([carregarUsuarios(), carregarResumo()]);
    carregarPagamentosUsuario();
  });

  $("#usr-teste").addEventListener("click", async () => {
    if (!confirm(`Liberar ${config.dias_teste} dias de teste grátis para ${atual.nome || atual.usuario}?`)) return;
    const r = await chamar("master_liberar_teste", { p_usuario: atual.id }).catch(() => null);
    if (!r) return;
    FM.aviso(`Teste liberado até ${FM.dataHora(r.vence_em)}`, "ok");
    carregarUsuarios(); carregarResumo();
  });

  $("#usr-sessao").addEventListener("click", async () => {
    await chamar("master_derrubar_sessao", { p_usuario: atual.id }, "Aparelho desconectado").catch(() => null);
    carregarUsuarios();
  });

  $("#usr-suspender").addEventListener("click", async () => {
    const suspender = !atual.suspenso;
    if (suspender && !confirm(`Suspender o acesso de ${atual.nome || atual.usuario}?`)) return;
    await chamar("master_suspender", { p_usuario: atual.id, p_suspenso: suspender }, suspender ? "Acesso suspenso" : "Acesso reativado").catch(() => null);
    carregarUsuarios(); carregarResumo();
  });

  $("#usr-salvar-vence").addEventListener("click", async () => {
    const v = $("#usr-vence").value;
    if (!v) { FM.aviso("Escolha uma data.", "erro"); return; }
    await chamar("master_definir_vencimento", { p_usuario: atual.id, p_vence: new Date(v).toISOString() }, "Vencimento atualizado").catch(() => null);
    carregarUsuarios(); carregarResumo();
  });

  $("#usr-senha").addEventListener("click", async () => {
    const senha = prompt("Nova senha (mínimo 6 caracteres):", gerarSenha());
    if (!senha) return;
    const { data, error } = await sb.functions.invoke("admin-usuarios", { body: { acao: "senha", id: atual.id, senha } });
    if (error || (data && data.erro)) { FM.aviso(await erroFuncao(error, data), "erro"); return; }
    FM.aviso("Senha alterada. O cliente foi desconectado.", "ok");
    carregarUsuarios();
  });

  $("#usr-excluir").addEventListener("click", async () => {
    const alvo = atual.usuario || "";
    const conf = prompt(`Isso apaga o usuário e todo o histórico dele. Para confirmar, digite o usuário:\n${alvo}`);
    if (conf === null) return;
    if (conf.trim().toLowerCase() !== alvo.toLowerCase()) { FM.aviso("Usuário não confere. Nada foi excluído.", "erro"); return; }
    const { data, error } = await sb.functions.invoke("admin-usuarios", { body: { acao: "excluir", id: atual.id } });
    if (error || (data && data.erro)) { FM.aviso(await erroFuncao(error, data), "erro"); return; }
    $("#dlg-usuario").close();
    FM.aviso("Usuário excluído.", "ok");
    carregarUsuarios(); carregarResumo();
  });

  $("#form-dados").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    await chamar("master_salvar_usuario", {
      p_usuario: atual.id, p_nome: $("#usr-nome").value.trim(), p_telefone: $("#usr-telefone").value.trim(),
      p_telegram: $("#usr-tg").value.trim().replace(/^@/, ""), p_observacao: $("#usr-obs").value.trim(),
    }, "Dados salvos").catch(() => null);
    carregarUsuarios();
  });

  async function carregarPagamentosUsuario() {
    const id = atual && atual.id;
    if (!id) return;
    const corpo = $("#usr-pagamentos");
    const { data, error } = await sb.from("pagamentos").select("*").eq("usuario_id", id).order("criado_em", { ascending: false });
    if (error) { corpo.innerHTML = `<tr><td colspan="6" class="vazio">${FM.esc(FM.erroAmigavel(error))}</td></tr>`; return; }
    if (!data.length) { corpo.innerHTML = `<tr><td colspan="6" class="vazio">Nenhum pagamento.</td></tr>`; return; }
    corpo.innerHTML = data.map((p) => `<tr>
      <td>${FM.dataHora(p.criado_em)}</td><td>${FM.esc(p.plano_nome)}</td><td>${FM.moeda(p.valor)}</td>
      <td>${FM.esc(p.forma)}${p.observacao ? `<div class="sub">${FM.esc(p.observacao)}</div>` : ""}</td>
      <td>${FM.data(p.vence_depois)}</td>
      <td><button class="btn pequeno perigo" type="button" data-apagar-pagamento="${p.id}" aria-label="Apagar pagamento">Apagar</button></td>
    </tr>`).join("");
  }

  document.addEventListener("click", async (ev) => {
    const b = ev.target.closest("[data-apagar-pagamento]");
    if (!b) return;
    if (!confirm("Apagar este registro de pagamento? O vencimento do usuário NÃO muda; ajuste a data manualmente se precisar.")) return;
    await chamar("master_excluir_pagamento", { p_pagamento: b.dataset.apagarPagamento }, "Pagamento apagado").catch(() => null);
    carregarPagamentosUsuario(); carregarUsuarios(); carregarResumo();
  });

  async function erroFuncao(error, data) {
    if (data && data.erro) return data.erro;
    try {
      if (error && error.context && typeof error.context.json === "function") {
        const j = await error.context.json();
        if (j && j.erro) return j.erro;
      }
    } catch (e) { /* ignora */ }
    if (error && /Failed to send|not found|404/i.test(error.message || "")) return "A função admin-usuarios não foi encontrada no Supabase. Confira se ela foi publicada.";
    return FM.erroAmigavel(error);
  }

  // ---------------- novo usuário ----------------
  function gerarSenha() {
    const letras = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789";
    const bytes = new Uint32Array(10);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => letras[b % letras.length]).join("");
  }

  $("#btn-novo").addEventListener("click", () => {
    $("#form-novo").reset();
    $("#form-novo").hidden = false;
    $("#novo-pronto").hidden = true;
    $("#novo-erro").textContent = "";
    $("#novo-senha").value = gerarSenha();
    $("#novo-liberar").innerHTML = `<option value="">Não liberar agora</option><option value="teste">Teste grátis (${config.dias_teste} dias)</option>` +
      planos.filter((p) => p.ativo).map((p) => `<option value="${p.id}">${FM.esc(p.nome)}: ${p.dias} dias, ${FM.moeda(p.valor)}</option>`).join("");
    $("#dlg-novo").showModal();
  });
  $("#btn-gerar-senha").addEventListener("click", () => ($("#novo-senha").value = gerarSenha()));

  $("#form-novo").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const erro = $("#novo-erro");
    erro.textContent = "";
    const nome = $("#novo-nome").value.trim();
    const usuario = $("#novo-usuario").value.trim().toLowerCase();
    const senha = $("#novo-senha").value.trim();
    if (!nome || !usuario) { erro.textContent = "Preencha nome e usuário."; return; }
    if (!/^[a-z0-9._-]{3,30}$/.test(usuario)) { erro.textContent = "Usuário: de 3 a 30 letras minúsculas, números, ponto, hífen ou sublinhado, sem espaço e sem acento."; return; }
    if (senha.length < 6) { erro.textContent = "A senha precisa ter pelo menos 6 caracteres."; return; }
    const botao = $("#btn-criar");
    botao.disabled = true;
    botao.textContent = "Criando…";
    try {
      const { data, error } = await sb.functions.invoke("admin-usuarios", {
        body: { acao: "criar", nome, usuario, senha, telefone: $("#novo-telefone").value.trim(), telegram: $("#novo-telegram").value.trim().replace(/^@/, ""), observacao: $("#novo-obs").value.trim() },
      });
      if (error || (data && data.erro)) throw new Error(await erroFuncao(error, data));
      const liberar = $("#novo-liberar").value;
      let validade = "";
      if (liberar === "teste") {
        const r = await chamar("master_liberar_teste", { p_usuario: data.id });
        validade = `\nAcesso de teste até: ${FM.dataHora(r.vence_em)}`;
      } else if (liberar) {
        const r = await chamar("master_renovar", { p_usuario: data.id, p_plano: liberar, p_valor: null, p_forma: "PIX", p_obs: "Cadastro" });
        validade = `\nAcesso válido até: ${FM.dataHora(r.vence_em)}`;
      }
      const endereco = new URL("./", location.href).href;
      $("#novo-mensagem").value = `Olá, ${nome}! Seu acesso ao Fluxo do Mercado está pronto.\n\nEndereço: ${endereco}\nUsuário: ${usuario}\nSenha: ${senha}${validade}\n\nNo computador ou no celular, você pode instalar o app pelo navegador (Minha conta > Instalar o app).`;
      $("#form-novo").hidden = true;
      $("#novo-pronto").hidden = false;
      carregarUsuarios(); carregarResumo();
    } catch (e) {
      erro.textContent = FM.erroAmigavel(e);
    } finally {
      botao.disabled = false;
      botao.textContent = "Criar usuário";
    }
  });

  $("#btn-copiar").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#novo-mensagem").value); FM.aviso("Copiado.", "ok"); }
    catch (e) { $("#novo-mensagem").select(); FM.aviso("Selecione e copie com Ctrl+C.", "erro"); }
  });

  // ---------------- planos ----------------
  async function carregarPlanos() {
    const { data, error } = await sb.from("planos").select("*").order("ordem").order("dias");
    if (error) { FM.aviso(FM.erroAmigavel(error), "erro"); return; }
    planos = data || [];
    renderPlanos();
  }

  function renderPlanos() {
    $("#planos").innerHTML = planos.map((p) => `
      <tr data-plano="${p.id}">
        <td><input class="campo-tabela" data-c="nome" type="text" value="${FM.esc(p.nome)}" aria-label="Nome do plano"></td>
        <td><input class="campo-tabela" data-c="dias" type="number" min="1" value="${p.dias}" aria-label="Dias" style="width:90px"></td>
        <td><input class="campo-tabela" data-c="valor" type="number" min="0" step="0.01" value="${Number(p.valor).toFixed(2)}" aria-label="Valor" style="width:120px"></td>
        <td><input class="campo-tabela" data-c="ordem" type="number" value="${p.ordem}" aria-label="Ordem" style="width:80px"></td>
        <td><button type="button" class="interruptor" data-c="ativo" aria-pressed="${p.ativo}" aria-label="Plano ativo"><span></span></button></td>
        <td><button class="btn pequeno" type="button" data-salvar-plano="${p.id}">Salvar</button></td>
      </tr>`).join("") || `<tr><td colspan="6" class="vazio">Nenhum plano. Clique em Adicionar plano.</td></tr>`;
    $$(".campo-tabela").forEach((i) => Object.assign(i.style, { minHeight: "40px", padding: "8px 10px", background: "#0D111A", border: "1px solid var(--borda)", borderRadius: "8px", color: "var(--texto)" }));
  }

  document.addEventListener("click", async (ev) => {
    const t = ev.target.closest('#planos .interruptor');
    if (t) { t.setAttribute("aria-pressed", String(t.getAttribute("aria-pressed") !== "true")); return; }
    const b = ev.target.closest("[data-salvar-plano]");
    if (!b) return;
    const linha = b.closest("tr");
    const v = (c) => linha.querySelector(`[data-c="${c}"]`);
    const dados = {
      nome: v("nome").value.trim(),
      dias: parseInt(v("dias").value, 10),
      valor: Number(v("valor").value || 0),
      ordem: parseInt(v("ordem").value || "0", 10),
      ativo: v("ativo").getAttribute("aria-pressed") === "true",
    };
    if (!dados.nome || !(dados.dias > 0)) { FM.aviso("Preencha nome e dias (maior que zero).", "erro"); return; }
    const { error } = await sb.from("planos").update(dados).eq("id", b.dataset.salvarPlano);
    if (error) { FM.aviso(FM.erroAmigavel(error), "erro"); return; }
    FM.aviso("Plano salvo.", "ok");
    carregarPlanos();
  });

  $("#btn-novo-plano").addEventListener("click", async () => {
    const { error } = await sb.from("planos").insert({ nome: "Novo plano", dias: 30, valor: 0, ordem: planos.length + 1, ativo: false });
    if (error) { FM.aviso(FM.erroAmigavel(error), "erro"); return; }
    FM.aviso("Plano criado desativado. Ajuste e ative.", "ok");
    carregarPlanos();
  });

  // ---------------- configurações ----------------
  async function carregarConfig() {
    const { data, error } = await sb.from("configuracoes").select("*").eq("id", 1).single();
    if (error) { FM.aviso(FM.erroAmigavel(error), "erro"); return; }
    config = data;
    $("#cfg-carencia").value = data.dias_carencia;
    $("#cfg-aviso").value = data.dias_aviso;
    $("#cfg-teste").value = data.dias_teste;
    $("#cfg-coletor").value = data.coletor_limite_seg;
    $("#cfg-telegram").value = data.telegram_usuario;
    $("#cfg-mensagem").value = data.mensagem_renovacao;
    $("#cfg-aviso-texto").value = data.aviso_geral;
    $("#cfg-aviso-ativo").setAttribute("aria-pressed", String(!!data.aviso_geral_ativo));
    $("#cfg-termos").value = data.termos_texto;
    $("#cfg-termos-nova").checked = false;
    $("#cfg-termos-versao").textContent = `(versão atual: ${data.termos_versao})`;
    atualizarTesteTelegram();
  }

  function atualizarTesteTelegram() {
    const link = FM.linkTelegram($("#cfg-telegram").value, FM.montarMensagem($("#cfg-mensagem").value, { nome: "Cliente Teste", usuario: "cliente.teste", plano: "Mensal" }));
    const a = $("#cfg-testar-telegram");
    if (link) { a.href = link; a.hidden = false; } else a.hidden = true;
  }
  $("#cfg-telegram").addEventListener("input", atualizarTesteTelegram);
  $("#cfg-mensagem").addEventListener("input", atualizarTesteTelegram);
  $("#cfg-aviso-ativo").addEventListener("click", (ev) => {
    const b = ev.currentTarget;
    b.setAttribute("aria-pressed", String(b.getAttribute("aria-pressed") !== "true"));
  });

  $("#form-config").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const n = (s) => parseInt($(s).value, 10);
    const dados = {
      dias_carencia: n("#cfg-carencia"),
      dias_aviso: n("#cfg-aviso"),
      dias_teste: n("#cfg-teste"),
      coletor_limite_seg: n("#cfg-coletor"),
      telegram_usuario: $("#cfg-telegram").value.trim().replace(/^@/, "").replace(/^https?:\/\/t\.me\//, ""),
      mensagem_renovacao: $("#cfg-mensagem").value.trim(),
      aviso_geral: $("#cfg-aviso-texto").value.trim(),
      aviso_geral_ativo: $("#cfg-aviso-ativo").getAttribute("aria-pressed") === "true",
      termos_texto: $("#cfg-termos").value,
      atualizado_em: new Date().toISOString(),
    };
    if ([dados.dias_carencia, dados.dias_aviso, dados.dias_teste, dados.coletor_limite_seg].some((x) => isNaN(x) || x < 0)) {
      FM.aviso("Confira os números dos prazos.", "erro");
      return;
    }
    if ($("#cfg-termos-nova").checked) dados.termos_versao = (config.termos_versao || 1) + 1;
    const { error } = await sb.from("configuracoes").update(dados).eq("id", 1);
    if (error) { FM.aviso(FM.erroAmigavel(error), "erro"); return; }
    FM.aviso("Configurações salvas.", "ok");
    await carregarConfig();
    carregarResumo();
    carregarUsuarios();
  });

  // ---------------- acessos ----------------
  async function carregarAcessos() {
    const corpo = $("#acessos");
    corpo.innerHTML = `<tr><td colspan="3" class="vazio">Carregando…</td></tr>`;
    const { data, error } = await sb.from("acessos").select("criado_em, aparelho, perfis(nome, usuario)").order("criado_em", { ascending: false }).limit(300);
    if (error) { corpo.innerHTML = `<tr><td colspan="3" class="vazio">${FM.esc(FM.erroAmigavel(error))}</td></tr>`; return; }
    if (!data.length) { corpo.innerHTML = `<tr><td colspan="3" class="vazio">Nenhum acesso ainda.</td></tr>`; return; }
    corpo.innerHTML = data.map((a) => `<tr>
      <td class="sub">${FM.dataHora(a.criado_em)}</td>
      <td><strong>${FM.esc((a.perfis && a.perfis.nome) || "—")}</strong><div class="sub">usuário: ${FM.esc((a.perfis && a.perfis.usuario) || "")}</div></td>
      <td>${FM.esc(a.aparelho)}</td>
    </tr>`).join("");
  }

  iniciar();
})();
