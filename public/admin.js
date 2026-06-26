let state = { user: null, summary: null };

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
  if (user?.role === "admin") {
    renderShell();
    await refresh();
    return;
  }
  renderShell();
  if (user) showMessage("This portal is admin only.");
}

function renderShell() {
  const isAdmin = state.user?.role === "admin";
  $("#authView").classList.toggle("hidden", isAdmin);
  $("#adminView").classList.toggle("hidden", !isAdmin);
  $("#logoutBtn").classList.toggle("hidden", !state.user);
  $("#sessionName").textContent = state.user ? `${state.user.name} (${state.user.role})` : "";
}

async function refresh() {
  state.summary = await api("/api/admin/summary");
  $("#weekLabel").textContent = state.summary.week;
  renderLeaderboard();
  renderPicks();
  renderEvents();
}

function userName(userId) {
  return state.summary.users.find((user) => user.id === userId)?.name || userId;
}

function eventName(eventId) {
  const event = state.summary.events.find((item) => item.id === eventId);
  return event ? `${event.awayTeam} at ${event.homeTeam}` : eventId;
}

function renderLeaderboard() {
  $("#leaderboard").innerHTML = `
    <div class="row header"><span>User</span><span>Points</span><span>Wins</span><span>Losses</span><span>Pending</span></div>
    ${state.summary.leaderboard.map((item, index) => `
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

function renderPicks() {
  $("#allPicks").innerHTML = `
    <div class="row admin-pick-row header"><span>Participant</span><span>Event</span><span>Selection</span><span>Result</span><span>Points</span></div>
    ${state.summary.picks.map((pick) => `
      <div class="row admin-pick-row">
        <strong>${userName(pick.userId)}</strong>
        <span>${eventName(pick.eventId)}</span>
        <span>${pick.selection} (${pick.stake})</span>
        <span>${pick.result}</span>
        <span>${pick.points}</span>
      </div>
    `).join("") || `<div class="row"><span class="muted">No picks to review.</span></div>`}
  `;
}

function renderEvents() {
  const openEvents = state.summary.events.filter((event) => event.status === "open");
  $("#openEvents").innerHTML = openEvents.map((event) => `
    <form class="panel settle-form" data-event-id="${event.id}">
      <h2>${event.awayTeam} at ${event.homeTeam}</h2>
      <p class="muted">${event.league} - ${new Date(event.startsAt).toLocaleString()}</p>
      <label>Winner
        <select name="winner">
          <option value="${event.awayTeam}">${event.awayTeam}</option>
          <option value="${event.homeTeam}">${event.homeTeam}</option>
          ${event.drawOdds ? `<option value="Draw">Draw</option>` : ""}
        </select>
      </label>
      <button type="submit">Set final</button>
    </form>
  `).join("") || `<div class="panel"><p class="muted">No open events to settle.</p></div>`;

  document.querySelectorAll(".settle-form").forEach((form) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await api("/api/admin/events", { method: "POST", body: JSON.stringify({ eventId: form.dataset.eventId, winner: formData(form).winner }) });
        showMessage("Event settled.");
        await refresh();
      } catch (error) {
        showMessage(error.message);
      }
    });
  });
}

$("#loginForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    const { user } = await api("/api/login", { method: "POST", body: JSON.stringify(formData(event.currentTarget)) });
    state.user = user;
    renderShell();
    if (user.role !== "admin") {
      showMessage("This portal is admin only.");
      return;
    }
    await refresh();
  } catch (error) {
    showMessage(error.message);
  }
});

$("#logoutBtn").addEventListener("click", async () => {
  await api("/api/logout", { method: "POST" });
  state = { user: null, summary: null };
  renderShell();
});

$("#syncOddsBtn").addEventListener("click", async () => {
  try {
    const result = await api("/api/admin/sync-odds", { method: "POST" });
    showMessage(`Imported ${result.imported} events.`);
    await refresh();
  } catch (error) {
    showMessage(error.message);
  }
});

loadSession();
