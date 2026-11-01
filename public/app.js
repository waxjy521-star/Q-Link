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
function connectSocket() {
  if (state.socket) state.socket.disconnect();
  state.socket = io({ auth: { token: state.token } });
  state.socket.on("message:new", msg => {
    if (state.active?.type === "dm" && Number(state.active.id) === Number(msg.sender_id)) {
      state.messages.push(msg); renderMessages();
    }
    loadFriends();
  });
  state.socket.on("group:message", msg => {
    if (state.active?.type === "group" && Number(state.active.id) === Number(msg.group_id)) {
      state.messages.push(msg); renderMessages();
    }
  });
  state.socket.on("presence:update", data => {
    const friend = state.friends.find(f => f.id === data.userId);
    if (friend) { friend.online = data.online; if (state.page === "messages" || state.page === "contacts") renderSideList(); }
  });
  state.socket.on("friend:request", () => { toast("收到新的好友申请"); loadFriends(); });
  state.socket.on("friend:accepted", () => { toast("好友申请已通过"); loadFriends(); });
}
async function loadAll() { await Promise.all([loadFriends(), loadGroups()]); renderSideList(); }
async function loadFriends() { try { state.friends = (await api("/friends")).friends; renderSideList(); } catch(e) { toast(e.message); } }
async function loadGroups() { try { state.groups = (await api("/groups")).groups; renderSideList(); } catch(e) { toast(e.message); } }
function renderSideList(filter = "") {
  const list = $("sideList"); const q = filter.toLowerCase();
  if (state.page === "groups") {
    list.innerHTML = `<div class="side-label">我的群聊 · ${state.groups.length}</div>` + state.groups.filter(g=>g.name.toLowerCase().includes(q)).map(g=>`
      <div class="side-item ${state.active?.type==="group"&&state.active.id===g.id?"active":""}" data-group="${g.id}">
        <div class="side-avatar">群</div><div class="side-meta"><b>${escapeHtml(g.name)}</b><span>${g.member_count} 位成员</span></div>
      </div>`).join("") || `<div class="empty-chat">还没有群聊</div>`;
  } else {
    const accepted = state.friends.filter(f=>f.status==="accepted" && (f.nickname.toLowerCase().includes(q)||f.username.includes(q)));
    const pending = state.friends.filter(f=>f.status==="pending" && f.incoming);
    list.innerHTML = `<div class="side-label">最近联系人 · ${accepted.length}</div>` + accepted.map(f=>`
      <div class="side-item ${state.active?.type==="dm"&&state.active.id===f.id?"active":""}" data-friend="${f.id}">
        <div class="side-avatar">${initials(f.nickname)}</div><div class="side-meta"><b>${escapeHtml(f.nickname)}</b><span>${f.online?"在线":"点击开始聊天"}</span></div>${f.online?'<i class="online-dot"></i>':''}
      </div>`).join("") + (pending.length ? `<div class="side-label">好友申请 · ${pending.length}</div>` + pending.map(f=>`
      <div class="side-item"><div class="side-avatar">＋</div><div class="side-meta"><b>${escapeHtml(f.nickname)}</b><span>等待处理</span></div><button class="small-btn accept-btn" data-accept="${f.id}">接受</button></div>`).join("") : "");
    if (!accepted.length && !pending.length) list.innerHTML += `<div class="empty-chat">这里还很安静，添加一位好友吧。</div>`;
  }
  list.querySelectorAll("[data-friend]").forEach(el=>el.onclick=()=>openChat("dm",Number(el.dataset.friend)));
  list.querySelectorAll("[data-group]").forEach(el=>el.onclick=()=>openChat("group",Number(el.dataset.group)));
  list.querySelectorAll("[data-accept]").forEach(el=>el.onclick=async e=>{e.stopPropagation();try{await api("/friends/accept",{method:"POST",body:JSON.stringify({userId:Number(el.dataset.accept)})});toast("已添加好友");loadAll();}catch(err){toast(err.message);}});
}
async function openChat(type, id) {
  state.active = { type, id };
  const person = type==="dm" ? state.friends.find(f=>f.id===id) : state.groups.find(g=>g.id===id);
  $("chatName").textContent = person?.nickname || person?.name || "会话";
  $("chatAvatar").textContent = initials(person?.nickname || person?.name || "Q");
  $("chatPresence").textContent = type==="dm" ? (person?.online?"在线":"Q-Link 好友") : `${person?.member_count || 1} 位成员`;
  $("welcomePanel").classList.add("hidden"); $("contentPanel").classList.add("hidden"); $("chatPanel").classList.remove("hidden");
  $("topContext").textContent = type==="dm" ? "私人会话" : "群组会话";
  document.querySelector(".app-shell").classList.add("mobile-chat");
  try {
    const data = type==="dm" ? await api(`/messages/${id}`) : await api(`/groups/${id}/messages`);
    state.messages = data.messages; renderMessages();
  } catch(e) { toast(e.message); }
  renderSideList();
}
function renderMessages() {
  const list = $("messageList");
  if (!state.messages.length) { list.innerHTML = `<div class="empty-chat">会话已就绪。发送第一条消息吧 ✦</div>`; return; }
  list.innerHTML = state.messages.map(m=>{
    const mine = m.sender_id === state.user.id;
    return `<div class="message-row ${mine?"mine":""}"><div class="msg-avatar">${initials(mine?state.user.nickname:m.nickname)}</div><div class="msg-content"><div class="msg-name">${escapeHtml(mine?state.user.nickname:m.nickname)}</div><div class="bubble">${escapeHtml(m.body)}</div><div class="msg-time">${new Date(m.created_at.replace(" ","T")+"Z").toLocaleString()}</div></div></div>`;
  }).join("");
  list.scrollTop = list.scrollHeight;
}
async function sendMessage(body) {
  if (!state.active) return;
  const endpoint = state.active.type==="dm" ? "/messages" : `/groups/${state.active.id}/messages`;
  const payload = state.active.type==="dm" ? { recipientId: state.active.id, body } : { body };
  try {
    const data = await api(endpoint,{method:"POST",body:JSON.stringify(payload)});
    if (!state.messages.some(m=>m.id===data.message.id)) state.messages.push(data.message);
    renderMessages();
  } catch(e) { toast(e.message); }
}
function renderPage() {
  document.querySelectorAll(".rail-btn").forEach(b=>b.classList.toggle("active",b.dataset.page===state.page));
  const titles={messages:"消息",contacts:"联系人",groups:"群聊",settings:"设置"};
  $("sectionTitle").textContent=titles[state.page]; $("topContext").textContent=titles[state.page];
  $("newAction").textContent=state.page==="groups"?"＋":"＋";
  $("chatPanel").classList.add("hidden"); $("welcomePanel").classList.add("hidden"); $("contentPanel").classList.add("hidden");
  if(state.page==="messages"){ $("welcomePanel").classList.remove("hidden"); renderSideList(); }
  else { $("contentPanel").classList.remove("hidden"); renderContentPage(); renderSideList(); }
  document.querySelector(".app-shell").classList.remove("mobile-chat");
}
function renderContentPage() {
  const panel=$("contentPanel");
  if(state.page==="contacts"){
    panel.innerHTML=`<h1 class="page-title">联系人</h1><p class="page-sub">寻找新朋友，管理你的连接。</p>
      <div class="content-card"><h3>添加好友</h3><div class="inline-form"><input id="friendQuery" placeholder="输入账号或昵称，至少 2 个字符"><button class="small-btn" id="searchFriends">搜索用户</button></div><div id="searchResults"></div></div>
      <div class="content-card"><h3>我的好友 · ${state.friends.filter(f=>f.status==="accepted").length}</h3><div id="friendDirectory"></div></div>`;
    $("friendDirectory").innerHTML=state.friends.filter(f=>f.status==="accepted").map(f=>`<div class="result-row"><div class="side-avatar">${initials(f.nickname)}</div><div class="result-info"><b>${escapeHtml(f.nickname)}</b><span>@${escapeHtml(f.username)} · ${f.online?"在线":"离线"}</span></div><button class="small-btn" data-start="${f.id}">聊天</button></div>`).join("")||"还没有好友。";
    $("searchFriends").onclick=searchUsers;
    panel.querySelectorAll("[data-start]").forEach(b=>b.onclick=()=>{state.page="messages";renderPage();openChat("dm",Number(b.dataset.start));});
  } else if(state.page==="groups"){
    panel.innerHTML=`<h1 class="page-title">群聊</h1><p class="page-sub">创建一个属于你们的小空间。</p><div class="content-card"><h3>创建群聊</h3><div class="inline-form"><input id="groupName" maxlength="40" placeholder="给群聊起个名字"><button class="small-btn" id="createGroup">创建群聊</button></div></div><div class="content-card"><h3>我的群聊</h3><div id="groupDirectory"></div></div>`;
    $("groupDirectory").innerHTML=state.groups.map(g=>`<div class="result-row"><div class="side-avatar">群</div><div class="result-info"><b>${escapeHtml(g.name)}</b><span>${g.member_count} 位成员</span></div><button class="small-btn" data-open-group="${g.id}">进入</button></div>`).join("")||"还没有群聊。";
    $("createGroup").onclick=createGroup;
    panel.querySelectorAll("[data-open-group]").forEach(b=>b.onclick=()=>openChat("group",Number(b.dataset.openGroup)));
  } else {
    panel.innerHTML=`<h1 class="page-title">设置</h1><p class="page-sub">让 Q-Link 更符合你的使用习惯。</p>
      <div class="content-card"><h3>个人资料</h3><label class="field">昵称<input id="profileNickname" maxlength="24" value="${escapeHtml(state.user.nickname)}"></label><label class="field">个人简介<input id="profileBio" maxlength="100" value="${escapeHtml(state.user.bio||"")}" placeholder="介绍一下自己"></label><label class="field">头像图片地址<input id="profileAvatar" maxlength="500" value="${escapeHtml(state.user.avatar||"")}" placeholder="可选，填写图片 URL"></label><button class="small-btn" id="saveProfile" style="margin-top:16px">保存资料</button></div>
      <div class="content-card"><h3>外观</h3><p class="page-sub">支持深色与浅色两种主题。</p><button class="small-btn" id="settingsTheme">切换主题</button></div>
      <div class="content-card"><h3>关于 Q-Link</h3><p class="page-sub">版本 0.1.0 · Qt × QQ 融合设计 · 当前为开发预览版。</p></div>`;
    $("saveProfile").onclick=saveProfile; $("settingsTheme").onclick=toggleTheme;
  }
}
async function searchUsers(){
  const q=$("friendQuery").value.trim(); if(q.length<2)return toast("至少输入 2 个字符。");
  try{
    const data=await api("/users/search?q="+encodeURIComponent(q));
    $("searchResults").innerHTML=data.users.map(u=>`<div class="result-row"><div class="side-avatar">${initials(u.nickname)}</div><div class="result-info"><b>${escapeHtml(u.nickname)}</b><span>@${escapeHtml(u.username)}</span></div><button class="small-btn" data-add="${u.id}">添加</button></div>`).join("")||`<p class="page-sub">没有找到匹配用户。</p>`;
    $("searchResults").querySelectorAll("[data-add]").forEach(b=>b.onclick=async()=>{try{await api("/friends/request",{method:"POST",body:JSON.stringify({userId:Number(b.dataset.add)})});b.textContent="已申请";b.disabled=true;toast("好友申请已发送");}catch(e){toast(e.message);}});
  }catch(e){toast(e.message);}
}
async function createGroup(){
  const name=$("groupName").value.trim();if(!name)return toast("请填写群名称。");
  try{await api("/groups",{method:"POST",body:JSON.stringify({name})});toast("群聊创建成功");await loadGroups();renderContentPage();}catch(e){toast(e.message);}
}
async function saveProfile(){
  try{const data=await api("/me",{method:"PATCH",body:JSON.stringify({nickname:$("profileNickname").value,bio:$("profileBio").value,avatar:$("profileAvatar").value})});state.user=data.user;$("miniName").textContent=state.user.nickname;$("miniAvatar").textContent=initials(state.user.nickname);$("railAvatar").textContent=initials(state.user.nickname);toast("个人资料已保存");}catch(e){toast(e.message);}
}
function toggleTheme(){document.body.classList.toggle("light");localStorage.setItem("qlink_theme",document.body.classList.contains("light")?"light":"dark");}
function logout(){localStorage.removeItem("qlink_token");state.token="";if(state.socket)state.socket.disconnect();state.user=null;state.active=null;showAuth();}
$("authForm").addEventListener("submit",async e=>{
  e.preventDefault();$("authError").textContent="";
  const payload={username:$("username").value.trim(),password:$("password").value,nickname:$("nickname").value.trim()};
  try{const data=await api(state.register?"/auth/register":"/auth/login",{method:"POST",body:JSON.stringify(payload)});state.token=data.token;state.user=data.user;localStorage.setItem("qlink_token",state.token);showApp();}
  catch(err){$("authError").textContent=err.message;}
});
$("switchAuth").onclick=()=>{state.register=!state.register;$("authTitle").textContent=state.register?"创建你的账号":"欢迎回来";$("authSub").textContent=state.register?"建立你的 Q-Link 身份，开始连接。":"登录你的 Q-Link 账号，继续连接。";$("nicknameWrap").classList.toggle("hidden",!state.register);$("authSubmit").innerHTML=state.register?"创建账号 <span>↗</span>":"登录 Q-Link <span>↗</span>";$("switchText").textContent=state.register?"已经有账号？":"还没有账号？";$("switchAuth").textContent=state.register?"返回登录":"创建账号";$("password").autocomplete=state.register?"new-password":"current-password";$("authError").textContent="";};
document.querySelectorAll(".rail-btn").forEach(b=>b.onclick=()=>{state.page=b.dataset.page;renderPage();});
$("newAction").onclick=()=>{if(state.page==="groups"){state.page="groups";renderPage();$("groupName")?.focus();}else{state.page="contacts";renderPage();$("friendQuery")?.focus();}};
$("globalSearch").addEventListener("input",e=>renderSideList(e.target.value));
$("messageForm").addEventListener("submit",e=>{e.preventDefault();const input=$("messageInput");const body=input.value.trim();if(!body)return;sendMessage(body);input.value="";input.style.height="auto";});
$("messageInput").addEventListener("keydown",e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();$("messageForm").requestSubmit();}});
$("messageInput").addEventListener("input",e=>{e.target.style.height="auto";e.target.style.height=Math.min(e.target.scrollHeight,120)+"px";});
$("logoutBtn").onclick=logout;$("themeBtn").onclick=toggleTheme;$("emojiBtn").onclick=()=>{$("messageInput").value+=" 😊";$("messageInput").focus();};
$("welcomeAdd").onclick=()=>{state.page="contacts";renderPage();$("friendQuery")?.focus();};
$("welcomeProfile").onclick=()=>{state.page="settings";renderPage();};
$("chatSearch").onclick=()=>toast("聊天记录搜索将在后续版本加入。");
if(localStorage.getItem("qlink_theme")==="light")document.body.classList.add("light");
(async function boot(){
  if(!state.token)return showAuth();
  try{const data=await api("/me");state.user=data.user;showApp();}
  catch{localStorage.removeItem("qlink_token");state.token="";showAuth();}
})();
