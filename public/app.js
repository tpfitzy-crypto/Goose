let state = { user: null, events: [], picks: [], leaderboard: [] };

const $ = (selector) => document.querySelector(selector);
const api = async (path, options = {}) => {
  const response = await fetch(path, {
    headers: { "content-type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
};

function showMessage(text) {
  const message = $("#message");
  message.textContent = text;
  message.classList.remove("hidden");
  window.setTimeout(() => message.classList.add("hidden"), 3600);
}

function formData(form) {
  return Object.fromEntries(new FormData(form).entries());
}

async function loadSession() {
  const { user } = await api("/api/session");
  state.user = user;
  renderShell();
  if (user) await refresh();
}

async function refresh() {
  const [events, picks, board] = await Promise.all([
    api("/api/events"),
    api("/api/picks"),
    api("/api/leaderboard")
  ]);
  state.events = events.events;
  state.picks = picks.picks;
  state.leaderboard = board.leaderboard;
  $("#weekLabel").textContent = board.week;
  renderLeaderboard();
  renderEvents();
  renderPicks();
}

function renderShell() {
  $("#authView").classList.toggle("hidden", Boolean(state.user));
  $("#appView").classList.toggle("hidden", !state.user);
  $("#logoutBtn").classList.toggle("hidden", !state.user);
  $("#sessionName").textContent = state.user ? `${state.user.name}` : "";
}

function renderLeaderboard() {
  $("#leaderboard").innerHTML = `
    <div class="row header"><span>User</span><span>Points</span><span>Wins</span><span>Losses</span><span>Pending</span></div>
    ${state.leaderboard.map((item, index) => `
      <div class="row">
        <strong>${index + 1}. ${item.name}</strong>
        <span>${item.points}</span>
        <span>${item.wins}</span>
        <span>${item.losses}</span>
        <span>${item.pending}</span>
      </div>
    `).join("") || `<div class="row"><span class="muted">No participants yet.</span></div>`}
  `;
}

function renderEvents() {
  const pickedIds = new Set(state.picks.map((pick) => pick.eventId));
  $("#events").innerHTML = state.events.map((event) => `
    <article class="event-card">
      <div class="meta"><span>${event.league} ${event.market}</span><span>${new Date(event.startsAt).toLocaleString()}</span></div>
      <div class="teams">
        <div class="team-line"><strong>${event.awayTeam}</strong><span>${event.awayOdds}</span></div>
        <div class="team-line"><strong>${event.homeTeam}</strong><span>${event.homeOdds}</span></div>
        ${event.drawOdds ? `<div class="team-line"><strong>Draw</strong><span>${event.drawOdds}</span></div>` : ""}
      </div>
      ${pickedIds.has(event.id) ? `<span class="pill">Pick placed</span>` : `
        <form class="pick-form" data-event-id="${event.id}">
          <select name="selection">
            <option value="${event.awayTeam}">${event.awayTeam}</option>
            <option value="${event.homeTeam}">${event.homeTeam}</option>
            ${event.drawOdds ? `<option value="Draw">Draw</option>` : ""}
          </select>
          <input name="stake" type="number" min="1" max="10" value="1">
          <button type="submit">Place pick</button>
        </form>
      `}
    </article>
  `).join("");

  document.querySelectorAll(".pick-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const data = formData(form);
        await api("/api/picks", { method: "POST", body: JSON.stringify({ eventId: form.dataset.eventId, ...data, stake: Number(data.stake) }) });
        showMessage("Pick placed.");
        await refresh();
      } catch (error) {
        showMessage(error.message);
      }
    });
  });
}

function renderPicks() {
  $("#myPicks").innerHTML = `
    <div class="row header"><span>Selection</span><span>Sport</span><span>Stake</span><span>Result</span><span>Points</span></div>
    ${state.picks.map((pick) => `
      <div class="row">
        <strong>${pick.selection}</strong>
        <span>${pick.sport}</span>
        <span>${pick.stake}</span>
        <span>${pick.result}</span>
        <span>${pick.points}</span>
      </div>
    `).join("") || `<div class="row"><span class="muted">No picks placed yet.</span></div>`}
  `;
}

document.querySelectorAll(".tabs button").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((item) => item.classList.remove("active"));
    document.querySelectorAll(".view").forEach((item) => item.classList.remove("active"));
    button.classList.add("active");
    $(`#${button.dataset.view}`).classList.add("active");
  });
});

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const { user } = await api("/api/login", { method: "POST", body: JSON.stringify(formData(event.currentTarget)) });
    state.user = user;
    renderShell();
    await refresh();
  } catch (error) {
    showMessage(error.message);
  }
});

$("#registerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const { user } = await api("/api/register", { method: "POST", body: JSON.stringify(formData(event.currentTarget)) });
    state.user = user;
    renderShell();
    await refresh();
  } catch (error) {
    showMessage(error.message);
  }
});

$("#logoutBtn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  state = { user: null, events: [], picks: [], leaderboard: [] };
  renderShell();
});

loadSession();
