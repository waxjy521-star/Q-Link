const $ = (id) => document.getElementById(id);
const state = { token: localStorage.getItem("qlink_token") || "", user: null, page: "messages", friends: [], groups: [], active: null, socket: null, register: false, messages: [] };
const api = async (url, options = {}) => {
  const res = await fetch("/api" + url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(state.token ? { Authorization: "Bearer " + state.token } : {}), ...(options.headers || {}) }
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "请求失败，请稍后重试。");
  return data;
};
function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 2600);
}
function initials(name = "Q") { return [...name.trim()].slice(0, 1).join("").toUpperCase() || "Q"; }
function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function showAuth() {
  $("authView").classList.remove("hidden"); $("appView").classList.add("hidden");
}
function showApp() {
  $("authView").classList.add("hidden"); $("appView").classList.remove("hidden");
  $("miniName").textContent = state.user.nickname; $("miniAvatar").textContent = initials(state.user.nickname);
  $("railAvatar").textContent = initials(state.user.nickname);
  connectSocket(); loadAll(); renderPage();
}
