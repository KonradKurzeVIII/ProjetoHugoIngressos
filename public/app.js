const $ = (id) => document.getElementById(id);
const sessionKey = "ingresos-session";
const state = { token: "", username: "", orders: [], pool: null, busy: false, mode: "login" };
let refreshPromise = null;
let cancelId = null;
let renderedOrders = null;

const messages = {
  POOL_CHEIO: "Os 100 lugares estão reservados. Seu pedido continua no carrinho. Você pode tentar novamente quando uma vaga for liberada.",
  COTA_PESSOAL: "Você já tem 2 reservas. Cancele uma delas para liberar sua cota.",
  USUARIO_EXISTENTE: "Esse nome de usuário já está em uso. Entre na conta ou escolha outro nome.",
  NAO_AUTORIZADO: "Usuário ou senha incorretos. Confira os dados e tente novamente.",
  DADOS_INVALIDOS: "Confira os campos preenchidos e tente novamente.",
  NAO_ENCONTRADO: "Esse pedido não foi encontrado na sua conta.",
  ESTADO_INVALIDO: "Esse pedido já mudou de estado. Atualize sua lista para conferir.",
  INDISPONIVEL: "O serviço está indisponível no momento. Tente novamente em instantes.",
};

function notify(message, kind = "success") {
  const feedback = $("feedback");
  feedback.textContent = message;
  feedback.className = `feedback ${kind}`;
  feedback.setAttribute("role", kind === "error" ? "alert" : "status");
  feedback.setAttribute("aria-live", kind === "error" ? "assertive" : "polite");
  feedback.hidden = false;
}

function persistSession() {
  try {
    if (state.token) sessionStorage.setItem(sessionKey, JSON.stringify({ token: state.token, username: state.username }));
    else sessionStorage.removeItem(sessionKey);
  } catch { /* The current page remains usable when browser storage is blocked. */ }
}

function clearSession() {
  state.token = "";
  state.username = "";
  state.orders = [];
  state.pool = null;
  persistSession();
  render();
}

async function api(path, { method = "GET", body, token = state.token } = {}) {
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let response;
  try {
    response = await fetch(path, {
      method, headers, cache: "no-store",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error("A conexão foi interrompida. Atualize seus pedidos para conferir o resultado antes de tentar novamente.");
  }
  const data = response.status === 201 && path === "/auth/registrar"
    ? null : await response.json();
  if (!response.ok) {
    if (response.status === 401 && token && token === state.token) {
      clearSession();
      throw new Error("Sua sessão expirou. Entre novamente para continuar.");
    }
    throw new Error(messages[data?.error] ?? "Não foi possível concluir a operação. Tente novamente.");
  }
  return { data, lote: response.headers.get("X-Lote") };
}

function ticketElement(order) {
  const reserved = order.status === "RESERVADO";
  const cancelled = order.status === "CANCELADO";
  const article = document.createElement("article");
  article.className = `ticket ${reserved ? "reserved" : cancelled ? "cancelled" : "cart"}`;
  article.dataset.orderId = String(order.id);
  const stub = document.createElement("div");
  stub.className = "ticket-stub";
  stub.textContent = "INGRESOS / SHOW 07";
  stub.setAttribute("aria-hidden", "true");
  const body = document.createElement("div");
  body.className = "ticket-body";
  const top = document.createElement("div");
  top.className = "ticket-top";
  const id = document.createElement("span");
  id.className = "ticket-id";
  id.textContent = `PEDIDO #${order.id}`;
  const badge = document.createElement("span");
  badge.className = "ticket-badge";
  badge.textContent = reserved ? "Reservado" : cancelled ? "Cancelado" : "No carrinho";
  top.append(id, badge);
  const title = document.createElement("h3");
  title.textContent = "Viva de perto.";
  const bottom = document.createElement("div");
  bottom.className = "ticket-bottom";
  const note = document.createElement("span");
  note.className = "ticket-note";
  note.textContent = reserved ? "Seu lugar está garantido." : cancelled ? "A vaga foi devolvida ao pool." : "Ainda não ocupa uma vaga.";
  bottom.append(note);
  if (!cancelled) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `ticket-action${reserved ? " cancel-action" : ""}`;
    button.textContent = reserved ? "Cancelar reserva" : "Reservar ingresso ↗";
    button.setAttribute("aria-label", `${reserved ? "Cancelar reserva" : "Reservar ingresso"} do pedido ${order.id}`);
    button.disabled = state.busy;
    button.addEventListener("click", () => reserved ? askCancellation(order.id) : reserve(order.id));
    bottom.append(button);
  }
  body.append(top, title, bottom);
  article.append(stub, body);
  return article;
}

function render() {
  const signedIn = Boolean(state.token);
  $("access").hidden = signedIn;
  $("session-card").hidden = !signedIn;
  $("login-link").hidden = signedIn;
  $("logout").hidden = !signedIn;
  $("account-name").hidden = !signedIn;
  $("account-name").textContent = state.username;
  $("account-avatar").textContent = state.username.slice(0, 1).toUpperCase();
  $("logout").disabled = state.busy;
  $("refresh").hidden = !signedIn;
  $("refresh").disabled = state.busy;
  $("add-cart").hidden = !signedIn;
  $("add-cart").disabled = state.busy;
  $("book").disabled = state.busy;
  $("book").textContent = state.busy ? "Processando…" : "Quero meu ingresso ↗";
  const personal = state.orders.filter((order) => order.status === "RESERVADO").length;
  $("personal-count").textContent = String(personal);
  $("quota-note").textContent = personal >= 2 ? "Cota completa. Você já tem seus dois lugares." : `Você ainda pode reservar ${2 - personal} ingresso${personal === 1 ? "" : "s"}.`;
  $("free-count").textContent = state.pool ? String(state.pool.livres) : "—";
  $("occupied-count").textContent = state.pool ? String(state.pool.ocupadas) : "—";
  $("pool-progress").hidden = !state.pool;
  $("pool-progress").value = state.pool?.ocupadas ?? 0;
  const badge = $("availability-badge");
  badge.className = `availability-badge${state.pool?.livres === 0 ? " sold-out" : ""}`;
  const dot = document.createElement("span");
  dot.className = "status-dot";
  badge.replaceChildren(dot, document.createTextNode(state.pool ? state.pool.livres ? "Reservas abertas" : "Esgotado no momento" : "100 lugares"));
  if (!signedIn) $("pool-freshness").textContent = "Entre para acompanhar a disponibilidade.";
  const list = $("ticket-list");
  const priority = { RESERVADO: 0, NO_CARRINHO: 1, CANCELADO: 2 };
  const orders = [...state.orders].sort((a, b) => priority[a.status] - priority[b.status] || b.id - a.id);
  const signature = orders.map((order) => `${order.id}:${order.status}`).join("|");
  if (signature !== renderedOrders) {
    list.replaceChildren(...orders.map(ticketElement));
    renderedOrders = signature;
  }
  for (const button of list.querySelectorAll("button")) button.disabled = state.busy;
  $("tickets-empty").hidden = orders.length > 0;
  $("empty-title").textContent = signedIn ? "Um lugar para você. Talvez mais um para alguém." : "Sua próxima história começa com um ingresso.";
  $("empty-description").textContent = signedIn ? "Reserve seu ingresso ou adicione um pedido ao carrinho para começar." : "Entre na sua conta para reservar e acompanhar seus pedidos.";
}

async function refreshSnapshot() {
  if (!state.token) return;
  if (refreshPromise) return refreshPromise;
  const token = state.token;
  refreshPromise = (async () => {
    const [pool, orders] = await Promise.all([api("/pool", { token }), api("/pedidos", { token })]);
    if (token !== state.token) return;
    state.pool = pool.data;
    state.orders = orders.data.pedidos;
    render();
    $("pool-freshness").textContent = `Atualizado às ${new Date().toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  })();
  try { await refreshPromise; } finally { refreshPromise = null; }
}

function focusAccess() {
  $("access").scrollIntoView({ behavior: "smooth", block: "center" });
  $("username").focus({ preventScroll: true });
}

async function runAction(operation) {
  if (state.busy) return;
  if (!state.token) { focusAccess(); return; }
  state.busy = true;
  render();
  $("feedback").hidden = true;
  try {
    if (refreshPromise) await refreshPromise;
    const message = await operation();
    await refreshSnapshot();
    notify(message);
  } catch (error) {
    try { await refreshSnapshot(); } catch { /* Keep the original action error. */ }
    notify(error.message, "error");
  } finally {
    state.busy = false;
    render();
  }
}

function reserve(id) {
  return runAction(async () => {
    const result = await api(`/pedidos/${id}/reservar`, { method: "POST" });
    return `Lugar garantido! Pedido #${id} reservado. Comprovante ${result.lote ?? "confirmado"}.`;
  });
}

function askCancellation(id) {
  if (state.busy) return;
  cancelId = id;
  $("cancel-order-id").textContent = `#${id}`;
  $("cancel-dialog").showModal();
}

function setMode(mode) {
  state.mode = mode;
  for (const name of ["login", "register"]) {
    const button = $(`${name}-mode`);
    button.classList.toggle("active", name === mode);
    button.setAttribute("aria-pressed", String(name === mode));
  }
  $("auth-submit").textContent = mode === "register" ? "Criar conta e entrar ↗" : "Entrar na minha conta ↗";
  $("password").autocomplete = mode === "register" ? "new-password" : "current-password";
}

$("login-mode").addEventListener("click", () => setMode("login"));
$("register-mode").addEventListener("click", () => setMode("register"));
$("toggle-password").addEventListener("click", () => {
  const show = $("password").type === "password";
  $("password").type = show ? "text" : "password";
  $("toggle-password").setAttribute("aria-label", show ? "Ocultar senha" : "Mostrar senha");
  $("toggle-password").setAttribute("aria-pressed", String(show));
});
$("auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.busy) return;
  const body = { username: $("username").value.trim(), password: $("password").value };
  if (!body.username) { $("username").focus(); return; }
  state.busy = true;
  $("auth-submit").disabled = true;
  $("auth-submit").textContent = "Conectando…";
  $("login-mode").disabled = true;
  $("register-mode").disabled = true;
  $("feedback").hidden = true;
  try {
    if (state.mode === "register") await api("/auth/registrar", { method: "POST", body, token: "" });
    const { data } = await api("/auth/login", { method: "POST", body, token: "" });
    state.token = data.token;
    state.username = body.username;
    $("password").value = "";
    $("password").type = "password";
    $("toggle-password").setAttribute("aria-label", "Mostrar senha");
    $("toggle-password").setAttribute("aria-pressed", "false");
    persistSession();
    await refreshSnapshot();
    notify(`Tudo pronto, ${state.username}. Escolha seu lugar e viva de perto.`);
  } catch (error) { notify(error.message, "error"); }
  finally {
    state.busy = false;
    $("auth-submit").disabled = false;
    $("login-mode").disabled = false;
    $("register-mode").disabled = false;
    setMode(state.mode);
    render();
  }
});
$("book").addEventListener("click", () => runAction(async () => {
  const cart = state.orders.find((order) => order.status === "NO_CARRINHO");
  const order = cart ?? (await api("/pedidos", { method: "POST", body: { showId: 7 } })).data;
  const { lote } = await api(`/pedidos/${order.id}/reservar`, { method: "POST" });
  return `Lugar garantido! Pedido #${order.id} reservado. Comprovante ${lote ?? "confirmado"}.`;
}));
$("add-cart").addEventListener("click", () => runAction(async () => {
  const { data } = await api("/pedidos", { method: "POST", body: { showId: 7 } });
  return `Pedido #${data.id} no carrinho. Reserve para garantir seu lugar.`;
}));
$("keep-ticket").addEventListener("click", () => $("cancel-dialog").close());
$("cancel-dialog").addEventListener("close", () => { cancelId = null; });
$("confirm-cancel").addEventListener("click", () => {
  const id = cancelId;
  $("cancel-dialog").close();
  if (id === null) return;
  runAction(async () => {
    await api(`/pedidos/${id}/cancelar`, { method: "POST" });
    return `Reserva #${id} cancelada. A vaga e sua cota estão livres novamente.`;
  });
});
$("logout").addEventListener("click", () => {
  if (state.busy) return;
  clearSession();
  notify("Você saiu da conta. Suas reservas continuam guardadas para o próximo acesso.", "info");
});
$("refresh").addEventListener("click", () => {
  if (state.busy) return;
  refreshSnapshot().catch((error) => notify(error.message, "error"));
});
setInterval(() => {
  if (!state.token || state.busy || document.hidden) return;
  refreshSnapshot().catch(() => {
    if (state.token) $("pool-freshness").textContent = "Não foi possível atualizar. Tentando novamente…";
  });
}, 5000);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && state.token && !state.busy) refreshSnapshot().catch((error) => notify(error.message, "error"));
});

try {
  const saved = JSON.parse(sessionStorage.getItem(sessionKey) ?? "null");
  if (saved && typeof saved.token === "string" && typeof saved.username === "string") {
    state.token = saved.token;
    state.username = saved.username;
  }
} catch { /* Ignore invalid or unavailable session storage. */ }
render();
if (state.token) refreshSnapshot().catch((error) => notify(error.message, "error"));
