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
    `${locked ? '<p class="panel warn">Question and settings changes are locked while students are taking the examination.</p>' : ""}<fieldset class="stack" ${locked ? "disabled" : ""}><section class="panel"><h2>Exam settings</h2><form id="settings" class="stack"><div class="grid">${field("Exam title", "exam_title", "text", cfg.exam_title, "maxlength=200 required")}${field("Duration (minutes)", "duration", "number", cfg.duration_seconds / 60, "min=0.016666 step=any max=1440 required")}${field("Registration access code (optional)", "access_code", "text", cfg.access_code, "maxlength=128")}<label>Detection sensitivity<select name="sensitivity">${opts(["standard", "sensitive"])}</select></label></div><button>Save settings</button></form></section><div class="grid"><section class="panel" id="editor"></section><section class="panel"><h2>Bulk JSON import</h2><form id="bulk" class="stack"><label>Question array (up to 150)<textarea rows="7" name="json" required></textarea></label><label>Import mode<select name="mode">${opts(["append", "replace"])}</select></label><details><summary>Sample format</summary><pre class="break" id="sample"></pre><button type="button" id="copySample">Copy sample</button></details><button>Import questions</button></form></section></div><section class="panel stack"><h2>Question list</h2>${qs.map((q, i) => `<article class="panel"><div class="row spread"><span class="pill">${q.type === "mcq" ? "MCQ" : "Subjective"}</span><small>${q.marks} marks</small></div><h3 class="break">${i + 1}. ${esc(q.text)}</h3>${questionImage(q)}${q.options.map((o, j) => `<p ${j === q.correct_option ? 'class="pill"' : ""}>${esc(o)}${j === q.correct_option ? " · Correct" : ""}</p>`).join("")}<div class="actions">${["up", "down", "edit", "delete"].map((k) => `<button data-action="${k}" data-index="${i}" ${(k === "up" && i === 0) || (k === "down" && i === qs.length - 1) ? "disabled" : ""}>${{ up: "Move up", down: "Move down", edit: "Edit", delete: "Delete" }[k]}</button>`).join("")}</div></article>`).join("") || "<p>No questions yet.</p>"}</section></fieldset>`;
  $("settings").elements.sensitivity.value = cfg.sensitivity;
  submitForm("settings", async (d) => {
    await api("settings", "PUT", {
      ...d,
      duration_seconds: Math.round(Number(d.duration) * 60),
    });
    notify("Exam settings saved.");
  });
  const sample = JSON.stringify(
    [
      {
        type: "mcq",
        text: "Which protocol provides reliable, ordered delivery?",
        marks: 1,
        options: ["TCP", "UDP"],
        correct_option: 0,
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
}"use strict";
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
    `${locked ? '<p class="panel warn">Question and settings changes are locked while students are taking the examination.</p>' : ""}<fieldset class="stack" ${locked ? "disabled" : ""}><section class="panel"><h2>Exam settings</h2><form id="settings" class="stack"><div class="grid">${field("Exam title", "exam_title", "text", cfg.exam_title, "maxlength=200 required")}${field("Duration (minutes)", "duration", "number", cfg.duration_seconds / 60, "min=0.016666 step=any max=1440 required")}${field("Registration access code (optional)", "access_code", "text", cfg.access_code, "maxlength=128")}<label>Detection sensitivity<select name="sensitivity">${opts(["standard", "sensitive"])}</select></label></div><button>Save settings</button></form></section><div class="grid"><section class="panel" id="editor"></section><section class="panel"><h2>Bulk JSON import</h2><form id="bulk" class="stack"><label>Question array (up to 150)<textarea rows="7" name="json" required></textarea></label><label>Import mode<select name="mode">${opts(["append", "replace"])}</select></label><details><summary>Sample format</summary><pre class="break" id="sample"></pre><button type="button" id="copySample">Copy sample</button></details><button>Import questions</button></form></section></div><section class="panel stack"><h2>Question list</h2>${qs.map((q, i) => `<article class="panel"><div class="row spread"><span class="pill">${q.type === "mcq" ? "MCQ" : "Subjective"}</span><small>${q.marks} marks</small></div><h3 class="break">${i + 1}. ${esc(q.text)}</h3>${questionImage(q)}${q.options.map((o, j) => `<p ${j === q.correct_option ? 'class="pill"' : ""}>${esc(o)}${j === q.correct_option ? " · Correct" : ""}</p>`).join("")}<div class="actions">${["up", "down", "edit", "delete"].map((k) => `<button data-action="${k}" data-index="${i}" ${(k === "up" && i === 0) || (k === "down" && i === qs.length - 1) ? "disabled" : ""}>${{ up: "Move up", down: "Move down", edit: "Edit", delete: "Delete" }[k]}</button>`).join("")}</div></article>`).join("") || "<p>No questions yet.</p>"}</section></fieldset>`;
  $("settings").elements.sensitivity.value = cfg.sensitivity;
  submitForm("settings", async (d) => {
    await api("settings", "PUT", {
      ...d,
      duration_seconds: Math.round(Number(d.duration) * 60),
    });
    notify("Exam settings saved.");
  });
  const sample = JSON.stringify(
    [
      {
        type: "mcq",
        text: "Which protocol provides reliable, ordered delivery?",
        marks: 1,
        options: ["TCP", "UDP"],
        correct_option: 0,
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