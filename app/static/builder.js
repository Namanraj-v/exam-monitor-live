"use strict";
async function encodeQuestionImage(file) {
  const allowed = ["image/png", "image/jpeg", "image/webp"];
  if (!allowed.includes(file.type)) {
    throw new Error("Choose a PNG, JPEG, or WebP image.");
  }
  if (["image/png", "image/jpeg"].includes(file.type) && file.size <= 1.8 * 1024 * 1024) {
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("Could not read the image."));
      reader.readAsDataURL(file);
    });
  }
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("This image could not be opened."));
      el.src = url;
    });
    const maxSide = 1400;
    const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    for (const q of [0.88, 0.78, 0.65, 0.5]) {
      const dataUrl = canvas.toDataURL("image/jpeg", q);
      const bytes = ((dataUrl.length - dataUrl.indexOf(",") - 1) * 3) / 4;
      if (bytes <= 1.9 * 1024 * 1024) return dataUrl;
    }
    throw new Error("Image is too large even after compression. Try a smaller file.");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  const src = text.replace(/^\ufeff/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

function parseCsvQuestions(text) {
  const rows = parseCsvRows(text);
  if (rows.length < 2) throw Error("CSV must include a header row and at least one question.");
  const headers = rows[0].map((h) => h.trim().toLowerCase().replace(/[\s-]+/g, "_"));
  const col = (...names) => headers.findIndex((h) => names.includes(h));
  const textIdx = col("question", "text", "question_text");
  if (textIdx < 0) throw Error("CSV needs a 'question' or 'text' column.");
  const typeIdx = col("type", "question_type");
  const marksIdx = col("marks", "score");
  const ansIdx = col("answer", "correct_answer", "correct", "correct_option");
  const ansColName = ansIdx >= 0 ? headers[ansIdx] : "";
  const optsIdx = col("options");
  const optCols = [
    ["option_a", "option_1", "a"],
    ["option_b", "option_2", "b"],
    ["option_c", "option_3", "c"],
    ["option_d", "option_4", "d"],
    ["option_e", "option_5", "e"],
    ["option_f", "option_6", "f"],
  ]
    .map((names) => col(...names))
    .filter((i) => i >= 0);

  return rows.slice(1).map((r, rowNum) => {
    const qText = (r[textIdx] || "").trim();
    if (!qText) throw Error(`Row ${rowNum + 2}: question text is empty.`);
    let options = optCols.map((i) => (r[i] || "").trim()).filter(Boolean);
    if (!options.length && optsIdx >= 0 && r[optsIdx]) {
      options = r[optsIdx].split(/[|;]/).map((s) => s.trim()).filter(Boolean);
    }
    const rawType = typeIdx >= 0 ? (r[typeIdx] || "").trim().toLowerCase() : "";
    const type = rawType || (options.length ? "mcq" : "subjective");
    const marksRaw = marksIdx >= 0 ? Number(r[marksIdx]) : 1;
    const marks = Number.isFinite(marksRaw) && marksRaw > 0 ? marksRaw : 1;
    if (type === "subjective") return { type: "subjective", text: qText, marks };
    if (type !== "mcq") throw Error(`Row ${rowNum + 2}: unsupported type '${type}'.`);
    const rawAns = ansIdx >= 0 ? (r[ansIdx] || "").trim() : "";
    if (!rawAns) throw Error(`Row ${rowNum + 2}: MCQ is missing an answer.`);
    const item = { type: "mcq", text: qText, marks, options };
    if (ansColName === "correct_option" && /^\d+$/.test(rawAns)) {
      item.correct_option = Number(rawAns);
    } else {
      item.answer = rawAns;
    }
    return item;
  });
}

async function builder() {
  const [settings, qs, sessions] = await Promise.all([
    api("settings"),
    api("questions"),
    api("sessions"),
  ]);
  cfg = settings;
  let locked = sessions.some((s) => s.status === "active");
  frame("builder", '<button id="refreshBuilder">Refresh</button>');
  button("refreshBuilder", builder);
  $("content").innerHTML =
    `${locked ? '<p class="panel warn">Question and settings changes are locked while students are taking the examination.</p>' : ""}<fieldset class="stack" ${locked ? "disabled" : ""}><section class="panel"><h2>Exam settings</h2><form id="settings" class="stack"><div class="grid">${field("Exam title", "exam_title", "text", cfg.exam_title, "maxlength=200 required")}${field("Duration (minutes)", "duration", "number", cfg.duration_seconds / 60, "min=0.016666 step=any max=1440 required")}${field("Registration access code (optional)", "access_code", "text", cfg.access_code, "maxlength=128")}<label>Detection sensitivity<select name="sensitivity">${opts(["standard", "sensitive"])}</select></label></div><div class="row spread"><div><strong>Negative marking</strong><div><small>When ON, awards 1 mark for each correct MCQ answer and -0.25 for each incorrect answer.</small></div></div><button type="button" id="negativeMarkingBtn" class="${cfg.negative_marking ? "primary" : ""}" aria-pressed="${cfg.negative_marking ? "true" : "false"}">Negative marking: ${cfg.negative_marking ? "ON" : "OFF"}</button></div><button>Save settings</button></form></section><div class="grid"><section class="panel" id="editor"></section><section class="panel"><h2>Upload MCQs &amp; Answer Key</h2><form id="bulk" class="stack"><label>Upload CSV or JSON file<input type="file" id="questionUploadFile" accept=".csv,.json,text/csv,application/json"></label><small id="uploadStatus">Upload a CSV or JSON file with MCQs and answers, or paste JSON below. Auto-matching and final marks apply only to MCQs.</small><label>Question array (JSON, up to 150)<textarea rows="7" name="json" required></textarea></label><label>Import mode<select name="mode">${opts(["append", "replace"])}</select></label><div class="actions"><button type="button" id="downloadCsvTemplate">Download CSV template</button><button class="primary">Import questions</button></div><details><summary>Sample JSON format</summary><pre class="break" id="sample"></pre><button type="button" id="copySample">Copy sample</button></details></form></section></div><section class="panel stack"><h2>Question list</h2>${qs.map((q, i) => `<article class="panel"><div class="row spread"><span class="pill">${q.type === "mcq" ? "MCQ" : "Subjective"}</span><small ${q.type === "mcq" ? `data-mcq-marks="${esc(q.marks)}"` : ""}>${cfg.negative_marking && q.type === "mcq" ? "+1 / -0.25 marks" : `${q.marks} marks`}</small></div><h3 class="break">${i + 1}. ${esc(q.text)}</h3>${questionImage(q)}${q.options.map((o, j) => `<p ${j === q.correct_option ? 'class="pill"' : ""}>${esc(o)}${j === q.correct_option ? " · Correct" : ""}</p>`).join("")}<div class="actions">${["up", "down", "edit", "delete"].map((k) => `<button data-action="${k}" data-index="${i}" ${(k === "up" && i === 0) || (k === "down" && i === qs.length - 1) ? "disabled" : ""}>${{ up: "Move up", down: "Move down", edit: "Edit", delete: "Delete" }[k]}</button>`).join("")}</div></article>`).join("") || "<p>No questions yet.</p>"}</section></fieldset>`;
  $("settings").elements.sensitivity.value = cfg.sensitivity;
  const renderNegativeBtn = () => {
    const on = Boolean(cfg.negative_marking);
    const btn = $("negativeMarkingBtn");
    if (!btn) return;
    btn.textContent = `Negative marking: ${on ? "ON" : "OFF"}`;
    btn.classList.toggle("primary", on);
    btn.setAttribute("aria-pressed", String(on));
    root.querySelectorAll("[data-mcq-marks]").forEach((el) => {
      el.textContent = on ? "+1 / -0.25 marks" : `${el.dataset.mcqMarks} marks`;
    });
  };
  button("negativeMarkingBtn", async () => {
    const btn = $("negativeMarkingBtn");
    const next = !cfg.negative_marking;
    btn.disabled = true;
    try {
      await api("settings", "PUT", {
        exam_title: cfg.exam_title,
        duration_seconds: cfg.duration_seconds,
        access_code: cfg.access_code,
        sensitivity: cfg.sensitivity,
        negative_marking: next,
      });
      cfg.negative_marking = next;
      renderNegativeBtn();
      notify(
        next
          ? "Negative marking turned ON (+1 correct, -0.25 incorrect)."
          : "Negative marking turned OFF.",
      );
    } finally {
      if ($("negativeMarkingBtn")) btn.disabled = false;
    }
  });
  submitForm("settings", async (d) => {
    const payload = {
      ...d,
      duration_seconds: Math.round(Number(d.duration) * 60),
      negative_marking: Boolean(cfg.negative_marking),
    };
    await api("settings", "PUT", payload);
    cfg = { ...cfg, ...payload };
    notify("Exam settings saved.");
  });
  const sample = JSON.stringify(
    [
      {
        type: "mcq",
        text: "Which protocol provides reliable, ordered delivery?",
        marks: 1,
        options: ["TCP", "UDP"],
        answer: "A",
      },
      {
        type: "subjective",
        text: "Describe a practical use of packet switching.",
        marks: 2,
      },
    ],
    null,
    2,
  );
  $("sample").textContent = sample;
  button("copySample", async () => {
    await navigator.clipboard.writeText(sample);
    notify("Sample copied.");
  });
  button("downloadCsvTemplate", () => {
    const csvText = [
      "question,option_a,option_b,option_c,option_d,answer,marks,type",
      '"Which protocol provides reliable ordered delivery?",TCP,UDP,ICMP,ARP,A,1,mcq',
      '"Which database property ensures all-or-nothing execution?",Atomicity,Consistency,Isolation,Durability,Atomicity,1,mcq',
      '"Explain packet switching in your own words.",,,,,,2,subjective',
    ].join("\r\n");
    const blob = new Blob([csvText], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "mcq-upload-template.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  });
  $("questionUploadFile").onchange = run(async () => {
    const file = $("questionUploadFile").files[0];
    if (!file) return;
    const content = await file.text();
    let parsed;
    if (file.name.toLowerCase().endsWith(".csv") || file.type === "text/csv") {
      parsed = parseCsvQuestions(content);
    } else {
      parsed = JSON.parse(content);
    }
    if (!Array.isArray(parsed) || parsed.length < 1 || parsed.length > 150) {
      throw Error("Upload between 1 and 150 questions.");
    }
    const mcqCount = parsed.filter((q) => q.type !== "subjective").length;
    const subCount = parsed.length - mcqCount;
    $("bulk").elements.json.value = JSON.stringify(parsed, null, 2);
    $("uploadStatus").textContent =
      `Loaded ${mcqCount} MCQ(s) with answer keys` +
      (subCount ? ` and ${subCount} subjective question(s) (excluded from auto-matching)` : "") +
      ` from ${file.name}. Click Import questions to save.`;
    notify(`Loaded ${parsed.length} question(s) from ${file.name}.`);
  });
  submitForm("bulk", async (d) => {
    let arr;
    try {
      arr = JSON.parse(d.json);
    } catch {
      throw Error("Enter a valid JSON array.");
    }
    if (!Array.isArray(arr) || arr.length < 1 || arr.length > 150)
      throw Error("Import between 1 and 150 questions.");
    if (d.mode === "replace" && !confirm("Replace all current questions?"))
      return;
    await api("questions/import", "POST", { questions: arr, mode: d.mode });
    await builder();
    notify("Question import complete.");
  });
  function editor(q) {
    const editing = Boolean(q);
    q ??= {
      text: "",
      type: "mcq",
      marks: 1,
      options: ["", ""],
      correct_option: 0,
    };
    $("editor").innerHTML =
      `<h2>${editing ? "Edit" : "Add"} question</h2><form class="stack" id="question"><div class="grid"><label>Type<select name="type" id="qtype"><option value="mcq">MCQ</option><option value="subjective">Subjective</option></select></label>${field("Marks", "marks", "number", q.marks, "min=0.001 step=any max=1000 required")}</div><label>Question text<textarea name="text" required maxlength="12000">${esc(q.text)}</textarea></label><label>Question image / diagram (optional)<input type="file" id="questionImageFile" accept="image/png,image/jpeg,image/webp" aria-describedby="questionImageHint"></label><small id="questionImageHint">PNG, JPEG, or WebP (large images are auto-compressed).</small><div id="imagePreview">${questionImage(q)}</div><button type="button" id="removeImage" ${q.image_id ? "" : "hidden"}>Remove image</button><div id="choiceEditor" class="stack"><div id="choices" class="stack"></div><div class="actions"><button type="button" id="more">Add option</button><button type="button" id="less">Remove last option</button></div><label>Correct option<select id="key"></select></label></div><div class="actions"><button class="primary">${editing ? "Save changes" : "Add question"}</button>${editing ? '<button type="button" id="cancelEdit">Cancel</button>' : ""}</div></form>`;
    const picker = $("questionImageFile"),
      preview = $("imagePreview"),
      remove = $("removeImage");
    let removed = false;
    picker.onchange = () => {
      const file = picker.files[0];
      if (!file) return;
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
        picker.value = "";
        preview.innerHTML = removed ? "" : questionImage(q);
        remove.hidden = removed || !q.image_id;
        notify("Choose a PNG, JPEG, or WebP image.");
        return;
      }
      const img = document.createElement("img");
      img.className = "question-image";
      img.alt = "Selected question image";
      const url = URL.createObjectURL(file);
      img.onload = () => URL.revokeObjectURL(url);
      img.onerror = () => {
        URL.revokeObjectURL(url);
        if (picker.files[0] === file) {
          picker.value = "";
          preview.innerHTML = removed ? "" : questionImage(q);
          remove.hidden = removed || !q.image_id;
          notify("This image could not be opened.");
        }
      };
      img.src = url;
      preview.replaceChildren(img);
      remove.hidden = false;
    };
    remove.onclick = () => {
      picker.value = "";
      removed = true;
      preview.replaceChildren();
      remove.hidden = true;
    };
    const choices = $("choices"),
      key = $("key");
    let initial = q.options.length ? [...q.options] : ["", ""];
    function option(v) {
      const i = choices.children.length + 1;
      choices.insertAdjacentHTML(
        "beforeend",
        field("Option " + i, "opt" + i, "text", v, "required maxlength=4000"),
      );
      key.add(new Option("Option " + i, String(i - 1)));
    }
    function status() {
      const mcq = $("qtype").value === "mcq";
      $("choiceEditor").hidden = !mcq;
      choices.querySelectorAll("input").forEach((el) => (el.disabled = !mcq));
      $("more").disabled = choices.children.length >= 6;
      $("less").disabled = choices.children.length <= 2;
    }
    initial.forEach(option);
    key.value = String(q.correct_option ?? 0);
    $("qtype").value = q.type;
    status();
    $("qtype").onchange = status;
    button("more", () => {
      option("");
      status();
    });
    button("less", () => {
      choices.lastElementChild.remove();
      key.remove(key.options.length - 1);
      if (key.selectedIndex < 0) key.selectedIndex = 0;
      status();
    });
    if (editing) button("cancelEdit", () => editor());
    submitForm("question", async (d) => {
      const mcq = d.type === "mcq";
      const file = picker.files[0];
      const image = file
        ? await encodeQuestionImage(file)
        : removed
          ? null
          : undefined;
      await api(
        editing ? `questions/${q.id}` : "questions",
        editing ? "PUT" : "POST",
        {
          image,
          type: d.type,
          text: d.text.trim(),
          marks: Number(d.marks),
          options: mcq
            ? [...choices.querySelectorAll("input")].map((el) =>
                el.value.trim(),
              )
            : [],
          correct_option: mcq ? Number(key.value) : null,
        },
      );
      await builder();
      notify("Question saved.");
    });
  }
  editor();
  root.querySelectorAll("[data-action]").forEach(
    (b) =>
      (b.onclick = run(async () => {
        const q = qs[Number(b.dataset.index)],
          a = b.dataset.action;
        if (a === "edit") {
          editor(q);
          $("editor").scrollIntoView();
          return;
        }
        if (a === "delete") {
          if (!confirm("Delete this question?")) return;
          await api("questions/" + q.id, "DELETE");
        } else await api(`questions/${q.id}/move`, "POST", { direction: a });
        await builder();
      })),
  );
}
