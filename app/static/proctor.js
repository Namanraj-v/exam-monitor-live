"use strict";
let selected,
  chartLib,
  charts = [],
  liveMonitorTimer = null,
  liveAuto = true,
  watchDetailTimer = null,
  watchReconnectTimer = null,
  watchingId = null,
  sessionList = [],
  renderList = null;
const pill = (v) =>
  `<span class="pill ${v === "High Suspicion" ? "hot" : v === "Review Required" ? "warn" : ""}">${esc(v)}</span>`;
const stat = (name, n) =>
  `<div class="stat"><small>${esc(name)}</small><strong>${esc(n)}</strong></div>`;
function syncSessionRow(fresh) {
  const idx = sessionList.findIndex((x) => x.id === fresh.id);
  if (idx < 0) return;
  sessionList[idx] = {
    ...sessionList[idx],
    status: fresh.status,
    mcq_score: fresh.mcq_score,
    mcq_max: fresh.mcq_max,
    mcq_correct: fresh.mcq_correct,
    mcq_incorrect: fresh.mcq_incorrect,
    mcq_unanswered: fresh.mcq_unanswered,
    mcq_total: fresh.mcq_total,
    negative_marking: fresh.negative_marking,
    suspicion_score: fresh.report?.suspicion_score ?? fresh.suspicion_score,
    verdict: fresh.report?.verdict ?? fresh.verdict,
  };
  sessionList.sort(
    (a, b) =>
      (a.status === "active" ? 0 : 1) - (b.status === "active" ? 0 : 1) ||
      b.suspicion_score - a.suspicion_score ||
      b.started_at - a.started_at,
  );
  renderList?.();
}
function stopLiveTimers() {
  clearInterval(liveMonitorTimer);
  liveMonitorTimer = null;
  stopWatchFeed(false);
}
function stopWatchFeed(notifyServer = true) {
  clearInterval(watchDetailTimer);
  clearTimeout(watchReconnectTimer);
  watchDetailTimer = null;
  watchReconnectTimer = null;
  const prev = watchingId;
  watchingId = null;
  const img = $("liveWatchImg");
  if (img) {
    img.onerror = null;
    img.src = "";
    img.hidden = true;
  }
  if (notifyServer && prev) {
    fetch(`/api/sessions/${prev}/live-frame`, {
      method: "DELETE",
      credentials: "same-origin",
    }).catch(() => {});
  }
}
function frame(tab, actions) {
  stopLiveTimers();
  renderList = null;
  charts.forEach((c) => c.destroy());
  charts = [];
  root.innerHTML = `<div class="row spread"><h1>Proctor workspace</h1><div class="actions">${actions}</div></div><nav class="tabs" aria-label="Proctor workspace"><button class="${tab === "monitor" ? "sel" : ""}" id="monitorTab">Monitor &amp; Reports</button><button class="${tab === "builder" ? "sel" : ""}" id="builderTab">Exam &amp; Questions</button></nav><div id="content" class="stack"></div>`;
  button("monitorTab", () => monitor());
  button("builderTab", builder);
}
async function monitor(keep = false) {
  sessionList = await api("sessions");
  frame(
    "monitor",
    `<button id="liveToggle">Auto-refresh: ${liveAuto ? "ON" : "OFF"}</button><button id="refresh">Refresh</button><a class="button primary" href="/api/export/results.csv" download>Download Results (CSV)</a>`,
  );
  button("refresh", () => monitor(true));
  button("liveToggle", () => {
    liveAuto = !liveAuto;
    $("liveToggle").textContent = "Auto-refresh: " + (liveAuto ? "ON" : "OFF");
  });
  $("content").innerHTML =
    `<div class="stats" id="topStats"></div><section class="panel stack"><h2>Examination sessions</h2><div class="row filters">${field("Search candidates", "search", "search", "", "id=search placeholder='Name or roll number'")}<label>Status<select id="status">${opts(["All", "Active", "Completed"])}</select></label><label>Verdict<select id="verdict">${opts(["All", "High Suspicion", "Review Required", "Clean"])}</select></label></div><div class="tablewrap" id="rows"></div></section><div id="detail" class="stack"></div>`;

  function renderStats() {
    if (!$("topStats")) return;
    $("topStats").innerHTML =
      `${stat("Candidates", sessionList.length)}${stat("In progress", sessionList.filter((s) => s.status === "active").length)}${stat("Submitted", sessionList.filter((s) => s.status === "completed").length)}${stat("Flagged for review", sessionList.filter((s) => s.verdict !== "Clean").length)}`;
  }
  function list() {
    if (!$("rows") || !$("search")) return;
    renderStats();
    let rows = sessionList.filter(
      (s) =>
        (s.candidate_name + " " + s.roll_no)
          .toLowerCase()
          .includes($("search").value.toLowerCase()) &&
        ($("status").value === "All" ||
          s.status === $("status").value.toLowerCase()) &&
        ($("verdict").value === "All" || s.verdict === $("verdict").value),
    );
    $("rows").innerHTML = rows.length
      ? `<table><thead><tr>${["Candidate / Roll no.", "Exam", "Status", "MCQ marks", "Review", "Started", ""].map((x) => `<th>${x}</th>`).join("")}</tr></thead><tbody>${rows.map((s) => `<tr><td><strong>${esc(s.candidate_name)}</strong><br><small>${esc(s.roll_no)}</small></td><td>${esc(s.exam_title)}</td><td>${pill(s.status)}</td><td>${s.mcq_score} / ${s.mcq_max}${s.mcq_total ? `<br><small>${s.mcq_correct ?? 0}/${s.mcq_total} matched</small>` : ""}</td><td>${s.suspicion_score} · ${pill(s.verdict)}</td><td>${stamp(s.started_at)}</td><td><button data-review="${esc(s.id)}">${s.status === "active" ? "Monitor Live" : "Review"}</button></td></tr>`).join("")}</tbody></table>`
      : "<p>No sessions match this view.</p>";
    $("rows")
      .querySelectorAll("[data-review]")
      .forEach((b) => (b.onclick = run(() => review(b.dataset.review, true))));
  }
  renderList = list;
  ["search", "status", "verdict"].forEach((id) => ($(id).oninput = list));
  list();

  liveMonitorTimer = setInterval(async () => {
    if (!liveAuto || !$("rows")) return;
    try {
      sessionList = await api("sessions");
      list();
    } catch {}
  }, 12000);

  if (keep && selected) await review(selected.id, false);
  else selected = null;
}
function gallery(s) {
  return s.evidence.length
    ? `<div class="gallery">${s.evidence.map((e) => `<button data-image="${esc(e.path)}"><img src="${esc(e.path)}" loading="lazy" alt="${esc(pretty(e.filename.split("-")[0]))}"><small>${esc(pretty(e.filename.split("-")[0]))} · ${stamp(e.created_at)}</small></button>`).join("")}</div>`
    : "<p>No images recorded.</p>";
}
function images(scope) {
  scope.querySelectorAll("[data-image]").forEach(
    (b) =>
      (b.onclick = () => {
        $("zoom").querySelector("img").src = b.dataset.image;
        $("zoom").showModal();
      }),
  );
}
function incidentList(r) {
  return r.corroborated_incidents.length
    ? `<ul>${r.corroborated_incidents.map((i) => `<li>${stamp(i.timestamp)} · ${esc(i.modalities.join(" + "))} · ${i.event_ids.length} observations</li>`).join("")}</ul>`
    : "<p>No cross-modal incidents recorded.</p>";
}
async function drawCharts(s) {
  const timeline = new Map(),
    channels = { video: 0, audio: 0, browser: 0 };
  for (const e of s.events) {
    let minute = Math.floor((e.timestamp - s.started_at) / 60) + 1;
    timeline.set(minute, (timeline.get(minute) || 0) + 1);
    channels[e.modality]++;
  }
  const fallback = () => {
    if (!$("timeline")) return;
    $("timeline").parentElement.textContent =
      [...timeline].map(([m, v]) => `Minute ${m}: ${v}`).join(" · ") ||
      "No activity recorded.";
    $("distribution").parentElement.textContent = Object.entries(channels)
      .map(([k, v]) => `${pretty(k)}: ${v}`)
      .join(" · ");
  };
  if (!window.Chart) {
    chartLib ??= new Promise((ok, no) => {
      const el = document.createElement("script");
      el.src =
        "https://cdn.jsdelivr.net/npm/chart.js@4.4.9/dist/chart.umd.min.js";
      el.onload = ok;
      el.onerror = no;
      document.head.append(el);
    });
    try {
      await chartLib;
    } catch {
      fallback();
      return;
    }
  }
  if (selected !== s || !$("timeline")) return;
  charts.forEach((c) => c.destroy());
  charts = [];
  let common = {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
  };
  let last = Math.max(1, ...timeline.keys()),
    mins = Array.from({ length: last }, (_, i) => i + 1);
  charts.push(
    new Chart($("timeline"), {
      type: "bar",
      data: {
        labels: mins,
        datasets: [
          {
            label: "Observations",
            data: mins.map((i) => timeline.get(i) || 0),
            backgroundColor: "#28644d",
          },
        ],
      },
      options: {
        ...common,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { precision: 0 } },
          x: { title: { display: true, text: "Minute of examination" } },
        },
      },
    }),
  );
  charts.push(
    new Chart($("distribution"), {
      type: "doughnut",
      data: {
        labels: ["Video", "Audio", "Browser"],
        datasets: [
          {
            data: Object.values(channels),
            backgroundColor: ["#28644d", "#bd7d36", "#5d78a1"],
          },
        ],
      },
      options: common,
    }),
  );
}
function observationSignal(e) {
  if (e.details.detector === "WebRTC VAD")
    return (e.details.voice_ms / 1000).toFixed(1) + " s voice activity";
  if (e.event_type === "head_turn") return "Pose threshold";
  if (e.details.reason === "suspected_person_swap") return "Geometry heuristic";
  if (e.modality === "browser") return "Browser event";
  if (e.event_type === "multiple_faces") return "Face count";
  return Math.round(e.confidence * 100) + "%";
}
function startWatchFeed(sid) {
  stopWatchFeed(true);
  watchingId = sid;
  const btn = $("watchLiveBtn");
  const img = $("liveWatchImg");
  const statusEl = $("liveWatchStatus");
  if (btn) btn.textContent = "Stop Live Feed";
  if (statusEl) statusEl.textContent = "Live stream active (5–6 FPS)";
  const connectStream = () => {
    const el = $("liveWatchImg");
    if (watchingId !== sid || !el) return;
    el.onerror = () => {
      if (watchingId !== sid) return;
      clearTimeout(watchReconnectTimer);
      watchReconnectTimer = setTimeout(connectStream, 1500);
    };
    el.src = `/api/sessions/${sid}/live-stream?t=${Date.now()}`;
    el.hidden = false;
  };
  if (img) connectStream();

  watchDetailTimer = setInterval(async () => {
    if (watchingId !== sid || !$("detail")) return;
    try {
      const fresh = await api(`sessions/${sid}`);
      if (watchingId !== sid || !$("detail")) return;
      selected = fresh;
      syncSessionRow(fresh);
      const r = fresh.report;
      if ($("liveStats")) {
        $("liveStats").innerHTML =
          `${stat("MCQ final marks", fresh.mcq_score + " / " + fresh.mcq_max)}${stat("MCQ matched", `${fresh.mcq_correct ?? 0} / ${fresh.mcq_total ?? 0}`)}${stat("Review score", r.suspicion_score)}${stat("Observations", fresh.events.length)}${stat("Cross-modal incidents", r.corroborated_incidents.length)}${stat("Suppressed flags", r.suppressed_false_positives.length)}`;
      }
      if ($("liveVerdict")) $("liveVerdict").innerHTML = pill(r.verdict);
      renderLogTable(fresh);
      if ($("liveGallery")) {
        $("liveGallery").innerHTML = gallery(fresh);
        images($("liveGallery"));
      }
      if (fresh.status !== "active") {
        stopWatchFeed(false);
        if ($("liveWatchStatus"))
          $("liveWatchStatus").textContent =
            "Candidate has submitted the examination.";
        if ($("watchLiveBtn")) $("watchLiveBtn").disabled = true;
      }
    } catch {}
  }, 5000);
}
function renderLogTable(s) {
  if (!$("log") || !$("channel")) return;
  let ev = s.events.filter(
    (e) =>
      $("channel").value === "All" ||
      e.modality === $("channel").value.toLowerCase(),
  );
  $("log").innerHTML = ev.length
    ? `<table><thead><tr>${["Time", "Channel", "Observation", "Severity", "Signal", "Details", "Evidence"].map((v) => `<th>${v}</th>`).join("")}</tr></thead><tbody>${ev
        .slice()
        .reverse()
        .map(
          (e) =>
            `<tr><td>${stamp(e.timestamp)}</td><td>${esc(e.modality)}</td><td>${esc(pretty(e.event_type))}</td><td>${esc(e.severity)}</td><td>${esc(observationSignal(e))}</td><td>${esc(
              Object.entries(e.details)
                .map(([k, v]) => pretty(k) + ": " + String(v))
                .join(", "),
            )}</td><td>${e.snapshot_path ? `<button data-image="${esc(e.snapshot_path)}">View snapshot</button>` : "—"}</td></tr>`,
        )
        .join("")}</tbody></table>`
    : "No observations in this channel.";
  images($("log"));
}
async function review(id, scroll) {
  stopWatchFeed(true);
  let s = await api(`sessions/${id}`);
  if (!$("detail")) return;
  selected = s;
  syncSessionRow(s);
  let r = s.report,
    models = s.telemetry.models_loaded || {};
  $("detail").innerHTML =
    `<section class="panel"><div class="row spread"><div><small>Session review</small><h2>${esc(s.candidate_name)}</h2></div><span id="liveVerdict">${pill(r.verdict)}</span></div><p>${esc(s.roll_no)} · ${esc(s.exam_title)} · ${stamp(s.started_at)}${s.negative_marking ? " · Negative marking (+1 / -0.25)" : ""}</p><p>Browser AI · ${["face", "object", "audio"].map((k) => `${k}: ${models[k] ? "active" : "unavailable"}`).join(" · ")}</p>${
      s.status === "active"
        ? `<div class="stack" style="margin-top:14px"><div class="actions"><button class="primary" id="watchLiveBtn">Watch Live Feed</button><small id="liveWatchStatus">Start live camera watch to observe this candidate in real time.</small></div><img id="liveWatchImg" hidden style="max-width:360px;width:100%;border-radius:8px;border:2px solid #175b48" alt="Live candidate feed"></div>`
        : ""
    }</section><div class="stats" id="liveStats">${stat("MCQ final marks", s.mcq_score + " / " + s.mcq_max)}${stat("MCQ matched", `${s.mcq_correct ?? 0} / ${s.mcq_total ?? 0}`)}${stat("Review score", r.suspicion_score)}${stat("Observations", s.events.length)}${stat("Cross-modal incidents", r.corroborated_incidents.length)}${stat("Suppressed flags", r.suppressed_false_positives.length)}</div><div class="grid"><section class="panel"><h3>Activity timeline</h3><div class="chart"><canvas id="timeline"></canvas></div></section><section class="panel"><h3>Signal distribution</h3><div class="chart"><canvas id="distribution"></canvas></div></section></div><section class="panel"><h2>Cross-modal assessment</h2><p>${esc(r.narrative)}</p><div class="actions"><button id="fusion" ${s.status !== "completed" ? "disabled" : ""}>Run fusion analysis</button><button id="reportBtn">Open report</button></div></section><section class="panel stack"><div class="row spread"><h2>Observation log</h2><label>Channel <select id="channel">${opts(["All", "Video", "Audio", "Browser"])}</select></label></div><div id="log" class="tablewrap"></div></section><section class="panel"><h2>Evidence snapshots</h2><div id="liveGallery">${gallery(s)}</div></section>`;
  renderLogTable(s);
  $("channel").onchange = () => renderLogTable(selected || s);
  images($("detail"));
  if ($("watchLiveBtn")) {
    button("watchLiveBtn", () => {
      if (watchingId === id) {
        stopWatchFeed(true);
        $("watchLiveBtn").textContent = "Watch Live Feed";
        $("liveWatchStatus").textContent = "Live watch stopped.";
      } else {
        startWatchFeed(id);
      }
    });
  }
  button("reportBtn", () => audit(selected || s));
  button("fusion", async () => {
    const b = $("fusion");
    b.disabled = true;
    b.textContent = "Analyzing…";
    try {
      await api(`sessions/${id}/fusion`, "POST");
      if ($("detail")) await review(id, false);
    } finally {
      if ($("fusion")) {
        b.disabled = false;
        b.textContent = "Run fusion analysis";
      }
    }
  });
  void drawCharts(s);
  if (scroll) $("detail").scrollIntoView({ behavior: "smooth" });
}
function verification(v) {
  if (!v) return "";
  let links = (v.sources || []).filter(
    (url) => typeof url === "string" && /^https?:\/\//i.test(url),
  );
  return `<p>${esc(v.narrative)}</p>${links.map((url, i) => `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Source ${i + 1}</a>`).join(" · ")}`;
}
function audit(s) {
  stopLiveTimers();
  const r = s.report;
  root.innerHTML = `<article class="stack"><div class="row noprint"><button id="back">Back to session</button><button id="print" class="primary">Print / Save PDF</button></div><small>Session Audit Report</small><h1>USAR, GGSIPU · Examination Integrity Audit</h1><section class="panel row spread"><div><h2>${esc(s.candidate_name)}</h2><p>${esc(s.roll_no)} · ${esc(s.exam_title)}${s.negative_marking ? " · Negative marking (+1 / -0.25)" : ""}</p><p>Started ${stamp(s.started_at)} · Submitted ${stamp(s.ended_at)}</p></div>${s.reference_photo_path ? `<img width="150" src="${esc(s.reference_photo_path)}" alt="Candidate reference photo">` : ""}</section><div class="stats">${stat("MCQ final marks", s.mcq_score + " / " + s.mcq_max)}${stat("MCQ matched", `${s.mcq_correct ?? 0}✓ · ${s.mcq_incorrect ?? 0}✗ · ${s.mcq_unanswered ?? 0}—`)}${stat("Review score", r.suspicion_score)}${stat("Verdict", r.verdict)}</div><p class="muted">Automatic answer matching and final marks apply to MCQ questions only. Subjective answers require manual proctor review.</p><section class="panel"><h2>Cross-modal assessment</h2><p>${esc(r.narrative)}</p><small>${esc(pretty(r.engine_used))}</small><h3>Corroborated incidents</h3>${incidentList(r)}<h3>Suppressed flags</h3>${r.suppressed_false_positives.length ? r.suppressed_false_positives.map((i) => `<p>${esc(pretty(i.event_type))} · retained weight ${i.retained_weight}</p>`).join("") : "<p>No suppressed flags.</p>"}</section><h2>Submitted answers</h2>${s.questions
    .map((q, i) => {
      const a = s.answers[q.id];
      const unanswered = a === undefined || String(a).trim() === "";
      const matched = !unanswered && String(a) === String(q.correct_option);
      const mcqStatus =
        q.type === "mcq"
          ? unanswered
            ? " · Unanswered (0)"
            : matched
              ? ` · Matched (+${s.negative_marking ? 1 : q.marks})`
              : ` · Mismatch (${s.negative_marking ? "-0.25" : "0"})`
          : " · Manual review (subjective)";
      return `<section class="panel"><small>Question ${i + 1} · ${q.type === "mcq" ? "MCQ" : "Subjective"} · ${q.type === "mcq" && s.negative_marking ? "+1 / -0.25 marks" : `${q.marks} marks`}${mcqStatus}</small><h3 class="break">${esc(q.text)}</h3>${questionImage(q, s.id)}<p class="break">${esc((q.type === "mcq" ? q.options[a] : a) || "No answer submitted.")}</p>${q.type === "mcq" ? `<small>Answer key · ${esc(q.options[q.correct_option])}</small>` : `<div data-result="${esc(q.id)}">${verification(s.verifications[q.id])}</div><button data-verify="${esc(q.id)}" ${s.status !== "completed" ? "disabled" : ""}>Verify answer</button>`}</section>`;
    })
    .join(
      "",
    )}<section class="panel"><h2>Evidence snapshots</h2>${gallery(s)}</section><div class="sig">Reviewing proctor signature and date</div></article>`;
  window.scrollTo(0, 0);
  button("back", () => monitor(true));
  button("print", () => window.print());
  images(root);
  root.querySelectorAll("[data-verify]").forEach(
    (b) =>
      (b.onclick = run(async () => {
        b.disabled = true;
        b.textContent = "Verifying…";
        try {
          let v = await api(
            `sessions/${s.id}/verify/${b.dataset.verify}`,
            "POST",
          );
          s.verifications[b.dataset.verify] = v;
          b.previousElementSibling.innerHTML = verification(v);
        } finally {
          b.disabled = false;
          b.textContent = "Verify answer";
        }
      })),
  );
}
