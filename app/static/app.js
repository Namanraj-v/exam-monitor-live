"use strict";
const $ = (id) => document.getElementById(id),
  root = $("app");
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (x) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        x
      ],
  );
const field = (title, name, type = "text", value = "", extra = "required") =>
  `<label>${esc(title)}<input name="${esc(name)}" type="${type}" value="${esc(value)}" ${extra}></label>`;
const opts = (values) =>
  values.map((v) => `<option>${esc(v)}</option>`).join("");
const values = (form) => Object.fromEntries(new FormData(form)),
  pretty = (v) => String(v ?? "").replaceAll("_", " "),
  stamp = (v) => (v ? new Date(v * 1000).toLocaleString() : "—");
let nextSubmitRetry = 0;
let noticeTimer,
  user,
  cfg,
  authState,
  edge,
  exam,
  draft = {},
  revision = 0,
  saved = 0,
  saving,
  queued = [],
  sending,
  timer,
  autosave,
  liveBridgeTimer,
  liveWatching = false,
  deadline,
  submitting = false;
function notify(message) {
  $("notice").textContent = message;
  $("notice").hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => ($("notice").hidden = true), 6500);
}
async function api(path, method = "GET", data) {
  const retryable = method === "GET" || method === "PUT" || path === "sessions";
  let lastErr;
  for (let attempt = 0; attempt < (retryable ? 2 : 1); attempt++) {
    try {
      const res = await fetch("/api/" + path, {
        method,
        credentials: "same-origin",
        headers: data ? { "Content-Type": "application/json" } : {},
        body: data ? JSON.stringify(data) : undefined,
        signal: AbortSignal.timeout(
          /\/(fusion|verify)\b/.test(path) ? 85000 : 18000,
        ),
      });
      const text = await res.text();
      let result = {};
      try {
        result = text ? JSON.parse(text) : {};
      } catch {
        result = {
          detail: "Server is temporarily busy. Please try again in a moment.",
        };
      }
      if (!res.ok) {
        if (
          attempt === 0 &&
          retryable &&
          [500, 502, 503, 504].includes(res.status)
        ) {
          await new Promise((r) => setTimeout(r, 1200));
          continue;
        }
        let msg = result.detail;
        throw Object.assign(
          new Error(
            Array.isArray(msg)
              ? msg.map((e) => e.msg).join(", ")
              : msg || "Request failed",
          ),
          { status: res.status },
        );
      }
      return result;
    } catch (err) {
      lastErr = err;
      if (attempt === 0 && retryable && !err.status) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}
function run(fn) {
  return async (e) => {
    try {
      await fn(e);
    } catch (err) {
      notify(err.message);
    }
  };
}
function submitForm(id, fn) {
  $(id).onsubmit = run(async (e) => {
    e.preventDefault();
    let b = e.submitter;
    if (b) b.disabled = true;
    try {
      await fn(values(e.target));
    } finally {
      if (b) b.disabled = false;
    }
  });
}
function button(id, fn) {
  $(id).onclick = run(fn);
}
function account(active = false) {
  $("account").innerHTML = user
    ? `<div class="row"><span>${esc(user.display_name)}</span>${active ? "" : '<button id="logout">Sign out</button>'}</div>`
    : "";
  if ($("logout"))
    button("logout", async () => {
      await api("auth/logout", "POST");
      stopLiveBridge();
      edge?.stop();
      location.reload();
    });
}
function stopLiveBridge() {
  clearTimeout(liveBridgeTimer);
  liveBridgeTimer = null;
  liveWatching = false;
}
function scheduleLiveBridge(delayMs) {
  clearTimeout(liveBridgeTimer);
  if (!exam) return;
  liveBridgeTimer = setTimeout(async () => {
    if (!exam || !edge?.running) return;
    try {
      let res;
      if (liveWatching) {
        const blob = await edge.liveBlob();
        const r = await fetch(`/api/sessions/${exam.id}/live-frame`, {
          method: "POST",
          credentials: "same-origin",
          headers: blob ? { "Content-Type": "image/jpeg" } : {},
          body: blob || undefined,
          signal: AbortSignal.timeout(5000),
        });
        res = r.ok ? await r.json() : { watch: false };
      } else {
        res = await api(`sessions/${exam.id}/live-frame`, "POST", {});
      }
      liveWatching = Boolean(res?.watch);
    } catch {
      liveWatching = false;
    }
    scheduleLiveBridge(liveWatching ? 200 : 12000);
  }, delayMs);
}
async function boot() {
  authState = await api("auth/status");
  user = authState.user;
  account();
  root.removeAttribute("aria-busy");
  const portalRole = location.pathname === "/proctor" ? "proctor" : "student";
  if (!user || user.role !== portalRole) {
    user = null;
    account();
    return auth();
  }
  if (user.role === "student" && authState.current_exam_status === "completed")
    return submitted(authState.current_session_id);
  cfg = await api("settings");
  if (user.role === "proctor") return monitor();
  precheck();
}
function submitted(id) {
  account(true);
  if (id) {
    try {
      localStorage.removeItem("exam:" + id);
    } catch {}
  }
  root.innerHTML =
    '<section class="panel"><h1>Examination Submitted Successfully</h1><button class="primary" id="exitLogin">Exit to Login</button></section>';
  button("exitLogin", async () => {
    await api("auth/logout", "POST");
    location.replace("/");
  });
}
function auth(mode = "login") {
  const proctor = location.pathname === "/proctor";
  const login = mode === "login",
    setup = mode === "setup",
    title = login
      ? proctor
        ? "Proctor Sign In"
        : "Student Sign In"
      : setup
        ? "Set up proctor account"
        : "Register as a student";
  root.innerHTML = `<section class="auth"><div class="mast"><span class="emblem" aria-hidden="true">E.</span><div><h1>Examination portal</h1><p>${proctor ? "Access the proctor workspace." : "Access your examination."}</p></div></div><div><h2>${title}</h2><form class="stack" id="credentials">${login ? "" : field("Full name", "display_name")}${field("Username", "username", "text", "", "required maxlength=80 autocomplete=username")}${field("Password", "password", "password", "", login ? "required autocomplete=current-password" : "required minlength=8 autocomplete=new-password")}${proctor && login && authState.proctor_pin_required ? field("Security PIN", "proctor_pin", "password") : ""}${mode === "register" && authState.access_code_required ? field("Exam access code", "access_code") : ""}<button class="primary">${title}</button></form><hr><div class="actions">${!proctor || setup ? '<button id="alternate">' + (login ? "Create student account" : "Back to sign in") + "</button>" : ""}${proctor && authState.setup_required && !setup ? '<button id="setup">Set up proctor</button>' : ""}</div><footer><small><a href="${proctor ? "/" : "/proctor"}">${proctor ? "Student portal" : "Proctor portal"}</a></small></footer></div></section>`;
  if ($("alternate"))
    button("alternate", () => auth(login ? "register" : "login"));
  if ($("setup")) button("setup", () => auth("setup"));
  submitForm("credentials", async (d) => {
    if (login) d.role = proctor ? "proctor" : "student";
    await api("auth/" + mode, "POST", d);
    await boot();
  });
}
function precheck() {
  let telemetry,
    ready = false;
  root.innerHTML = `<h1>Examination pre-check</h1><p>${esc(cfg.exam_title)} · ${Math.ceil(cfg.duration_seconds / 60)} minutes${cfg.negative_marking ? " · Negative marking (+1 / -0.25)" : ""}</p><div class="grid"><section class="panel stack"><h2>Candidate details</h2>${field("Roll number", "roll_no", "text", "", 'required inputmode=numeric maxlength=11 pattern="[0-9]{11}" aria-describedby=rollHelp id=roll')}<small id="rollHelp">11-digit numeric roll number required</small><label class="choice"><input type="checkbox" id="consent"> I consent to camera, microphone and browser monitoring during the examination, including evidence snapshots for proctor review.</label><div class="actions"><button id="check">Check devices</button><button class="primary" id="begin" disabled>Begin examination</button></div><p id="progress" role="status"></p></section><section class="panel"><h2>Camera preview</h2><video id="video" muted playsinline autoplay></video></section></div>`;
  const gate = () => {
    $("begin").disabled =
      !ready || !$("consent").checked || !/^[0-9]{11}$/.test($("roll").value);
    $("check").disabled = !$("consent").checked || ready;
  };
  $("consent").onchange = () => {
    if (!$("consent").checked) {
      edge?.stop();
      ready = false;
      $("progress").textContent = "";
    }
    gate();
  };
  $("roll").oninput = () => {
    $("roll").value = $("roll")
      .value.replace(/[^0-9]/g, "")
      .slice(0, 11);
    gate();
  };
  gate();
  button("check", async () => {
    $("check").disabled = true;
    try {
      edge?.stop();
      edge = new ExamEdge($("video"), {
        sensitivity: cfg.sensitivity,
        onProgress: (text) => {
          $("progress").textContent = text;
        },
        onEvent: enqueue,
        onLock: lock,
      });
      telemetry = await edge.prepare();
      ready = true;
    } finally {
      gate();
    }
  });
  button("begin", async () => {
    $("begin").disabled = true;
    try {
      await edge.fullscreen();
      exam = await api("sessions", "POST", {
        candidate_name: user.display_name,
        roll_no: $("roll").value.trim(),
        telemetry,
        reference_photo: edge.photo(),
      });
      await showExam();
    } catch (e) {
      if (!exam && document.fullscreenElement) await document.exitFullscreen();
      throw e;
    } finally {
      if ($("begin")) gate();
    }
  });
}
function enqueue(ev) {
  if (!exam) return;
  if (queued.length >= 50) queued.splice(sending ? 1 : 0, 1);
  queued.push({ event: ev, capturedAt: performance.now() });
  void flushEvents();
}
async function flushEvents() {
  if (sending) return sending;
  sending = (async () => {
    while (queued.length) {
      try {
        const { event, capturedAt } = queued[0];
        const res = await api(`sessions/${exam.id}/events`, "POST", {
          ...event,
          queue_delay_seconds: (performance.now() - capturedAt) / 1000,
        });
        if (res?.watch && !liveWatching) {
          liveWatching = true;
          scheduleLiveBridge(200);
        }
        queued.shift();
      } catch (e) {
        if (e.status === 422) {
          queued.shift();
          continue;
        }
        break;
      }
    }
  })();
  try {
    await sending;
  } finally {
    sending = null;
  }
}
function lock(reason) {
  if (!$("overlay")) return;
  $("overlay").hidden = !reason;
  const examLayout = root.querySelector(".exam");
  if (examLayout) examLayout.inert = Boolean(reason);
  if (!reason) return;
  const fs = reason === "fullscreen";
  $("overlay").innerHTML =
    `<section class="panel"><h2>${fs ? "Fullscreen mode is required during the examination." : "Reconnect your camera and microphone."}</h2><button id="recover">${fs ? "Return to Fullscreen" : "Reconnect devices"}</button></section>`;
  button("recover", async () => {
    if (fs) await edge.fullscreen();
    else await edge.recover();
  });
  $("recover").focus();
}
function questionImage(q, sessionId) {
  if (!q.image_id) return "";
  const url =
    "/api/question-images/" +
    encodeURIComponent(q.image_id) +
    (sessionId ? "?session_id=" + encodeURIComponent(sessionId) : "");
  return `<img class="question-image" src="${url}" alt="Image for question ${esc(q.position)}">`;
}
function progress() {
  const n = exam.questions.filter((q) =>
    String(draft[q.id] ?? "").trim(),
  ).length;
  $("count").textContent = `${n} of ${exam.questions.length} answered`;
  $("meter").value = n;
}
function updateDraft(id, value) {
  draft[id] = value;
  revision++;
  $("save").textContent = "Changes pending";
  try {
    localStorage.setItem("exam:" + exam.id, JSON.stringify(draft));
  } catch {
    $("save").textContent = "Device storage unavailable";
  }
  progress();
}
async function persist() {
  if (saving) return saving;
  if (saved === revision) return;
  saving = (async () => {
    while (saved !== revision) {
      const version = revision,
        sid = exam.id;
      await api(`sessions/${sid}/answers`, "PUT", { answers: { ...draft } });
      saved = version;
    }
    if ($("save")) $("save").textContent = "Saved";
  })();
  try {
    await saving;
  } catch (e) {
    if ($("save")) $("save").textContent = "Waiting to sync";
    throw e;
  } finally {
    saving = null;
  }
}
async function showExam() {
  account(true);
  let cached = {};
  try {
    cached = JSON.parse(localStorage.getItem("exam:" + exam.id) || "{}");
  } catch {}
  draft = { ...exam.answers, ...cached };
  revision = 1;
  saved = 0;
  deadline = Date.now() + exam.remaining_seconds * 1000;
  const neg = Boolean(exam.settings?.negative_marking);
  root.innerHTML = `<h1>${esc(exam.exam_title)}</h1>${neg ? '<p class="muted">Negative marking is enabled: +1 mark for each correct MCQ answer and -0.25 mark for each incorrect answer.</p>' : ""}<div class="exam"><section class="stack">${exam.questions.map((q, i) => `<section class="panel question"><small>Question ${i + 1} · ${q.type === "mcq" && neg ? "+1 / -0.25 marks" : `${esc(q.marks)} marks`}</small><h2 class="break">${esc(q.text)}</h2>${questionImage(q, exam.id)}${q.type === "mcq" ? q.options.map((o, j) => `<label class="choice"><input type="radio" name="${esc(q.id)}" data-answer="${esc(q.id)}" value="${j}" ${String(draft[q.id]) === String(j) ? "checked" : ""}>${esc(o)}</label>`).join("") : `<textarea maxlength="50000" data-answer="${esc(q.id)}" aria-label="Answer to question ${i + 1}">${esc(draft[q.id])}</textarea>`}</section>`).join("")}<button class="primary" id="submitExam">Submit examination</button></section><aside class="panel side stack"><div><small>Time remaining</small><div class="timer" id="time"></div></div><div><b id="count"></b><progress id="meter" max="${exam.questions.length}"></progress><span class="pill" id="save">Saved</span></div><video id="video" autoplay muted playsinline></video><div class="row"><span class="pill">Camera Active</span><span class="pill">Mic Active</span><span class="pill">Proctoring Active</span></div></aside></div><div id="overlay" class="overlay" hidden></div>`;
  await edge.attach($("video"));
  edge.start();
  scheduleLiveBridge(3500);
  root
    .querySelectorAll("[data-answer]")
    .forEach(
      (el) => (el.oninput = () => updateDraft(el.dataset.answer, el.value)),
    );
  progress();
  button("submitExam", () => {
    $("submitCount").textContent =
      $("meter").value + " of " + exam.questions.length + " questions answered";
    $("submitDialog").showModal();
  });
  function tick() {
    const secs = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    $("time").textContent = [
      Math.floor(secs / 3600),
      Math.floor(secs / 60) % 60,
      secs % 60,
    ]
      .map((n) => String(n).padStart(2, "0"))
      .join(":");
    if (!secs && !submitting && Date.now() >= nextSubmitRetry)
      void completeExam().catch((e) => notify(e.message));
  }
  autosave = setInterval(() => {
    void persist().catch(() => {});
    void flushEvents();
  }, 10000);
  timer = setInterval(tick, 1000);
  tick();
}
async function completeExam() {
  if (submitting) return;
  $("submitDialog").close();
  submitting = true;
  stopLiveBridge();
  edge?.pause();
  root
    .querySelectorAll("[data-answer],#submitExam")
    .forEach((el) => (el.disabled = true));
  try {
    await persist();
    const remainingGrace = Math.max(0, deadline + 90000 - Date.now() - 15000);
    await Promise.race([
      flushEvents(),
      new Promise((done) => setTimeout(done, Math.min(5000, remainingGrace))),
    ]);
    await api(`sessions/${exam.id}/complete`, "POST");
    clearInterval(autosave);
    clearInterval(timer);
    edge?.stop();
    queued.length = 0;
    try {
      localStorage.removeItem("exam:" + exam.id);
    } catch {}
    exam = null;
    if (document.fullscreenElement)
      await document.exitFullscreen().catch(() => {});
    submitted();
  } catch (e) {
    if (e.status === 409) {
      clearInterval(timer);
      clearInterval(autosave);
      edge?.stop();
      exam = null;
      queued.length = 0;
      if (document.fullscreenElement)
        await document.exitFullscreen().catch(() => {});
      root.innerHTML =
        "<section class='panel'><h1>Submission window closed</h1><p>Contact your proctor to confirm which answers were received.</p></section>";
      account();
      return;
    }
    edge?.resume();
    scheduleLiveBridge(3500);
    nextSubmitRetry = Date.now() + 5000;
    root
      .querySelectorAll("[data-answer],#submitExam")
      .forEach((el) => (el.disabled = Date.now() >= deadline));
    throw e;
  } finally {
    submitting = false;
  }
}
window.addEventListener("online", () => {
  if (exam) {
    void persist().catch(() => {});
    void flushEvents();
  }
});
if ($("cancelSubmit")) button("cancelSubmit", () => $("submitDialog").close());
if ($("confirmSubmit")) button("confirmSubmit", completeExam);
if ($("closeZoom")) button("closeZoom", () => $("zoom").close());
boot().catch((e) => {
  root.textContent = e.message;
  root.removeAttribute("aria-busy");
});
