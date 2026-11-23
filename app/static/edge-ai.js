/* Camera frames and audio samples stay on the device until an evidence event. */
(() => {
  "use strict";
  const cdn =
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22-rc.20250304";
  const models = "https://storage.googleapis.com/mediapipe-models/";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const percent = (n) => Math.round(n * 100) + "%";
  const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
  const snapshotTypes = new Set([
    "phone_detected",
    "multiple_faces",
    "multiple_persons",
    "no_face_detected",
    "book_detected",
    "head_turn",
    "sustained_speech",
    "tab_switch",
    "fullscreen_exit",
    "copy_paste",
  ]);
  const cooldown = {
    phone_detected: 6,
    multiple_faces: 8,
    multiple_persons: 8,
    no_face_detected: 8,
    book_detected: 10,
    head_turn: 10,
    eye_gaze_away: 10,
    sustained_speech: 12,
    brief_ambient_sound: 15,
    tab_switch: 4,
    window_blur: 12,
    fullscreen_exit: 5,
    copy_paste: 5,
    context_menu: 10,
    blocked_shortcut: 5,
    camera_lost: 10,
    microphone_lost: 10,
    monitoring_gap: 10,
  };
  const stamp = (date) => {
    const pad = (n) => String(n).padStart(2, "0");
    return (
      date.getFullYear() +
      "-" +
      pad(date.getMonth() + 1) +
      "-" +
      pad(date.getDate()) +
      " " +
      [date.getHours(), date.getMinutes(), date.getSeconds()].map(pad).join(":")
    );
  };
  function captureAnnotatedSnapshot(video, boxes = [], title = "") {
    if (!video || !video.videoWidth || video.readyState < 2) return null;
    const canvas = document.createElement("canvas");
    canvas.width = Math.min(480, video.videoWidth);
    const scale = canvas.width / video.videoWidth;
    canvas.height = Math.round(video.videoHeight * scale);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    ctx.font = "bold 13px sans-serif";
    for (const box of boxes) {
      const x = box.x * scale,
        y = box.y * scale;
      ctx.strokeStyle = "#ef4444";
      ctx.lineWidth = 3;
      ctx.strokeRect(x, y, box.w * scale, box.h * scale);
      const width = ctx.measureText(box.label).width + 10;
      const left = Math.max(0, Math.min(x, canvas.width - width));
      const top = Math.max(
        title ? 25 : 0,
        Math.min(y - 20, canvas.height - 20),
      );
      ctx.fillStyle = "#ef4444";
      ctx.fillRect(left, top, width, 20);
      ctx.fillStyle = "#fff";
      ctx.fillText(box.label, left + 5, top + 15);
    }
    if (title) {
      ctx.fillStyle = "rgba(12,18,32,.88)";
      ctx.fillRect(0, 0, canvas.width, 24);
      ctx.fillStyle = "#fff";
      ctx.fillText(title + "  " + stamp(new Date()), 6, 17, canvas.width - 12);
    }
    for (const quality of [0.72, 0.6, 0.45, 0.3]) {
      const url = canvas.toDataURL("image/jpeg", quality);
      if (url.length - url.indexOf(",") - 1 <= (150 * 1024 * 4) / 3) return url;
    }
    return null;
  }
  function bounds(points, video) {
    const xs = points.map((p) => p.x),
      ys = points.map((p) => p.y);
    const x = Math.min(...xs),
      y = Math.min(...ys);
    return {
      x: x * video.videoWidth,
      y: y * video.videoHeight,
      w: (Math.max(...xs) - x) * video.videoWidth,
      h: (Math.max(...ys) - y) * video.videoHeight,
    };
  }
  function irisHorizontalRatio(lm) {
    if (!lm || lm.length <= 473) return null;
    const rDen = lm[133].x - lm[33].x;
    const lDen = lm[263].x - lm[362].x;
    if (Math.abs(rDen) < 1e-4 || Math.abs(lDen) < 1e-4) return null;
    const rRatio = (lm[468].x - lm[33].x) / rDen;
    const lRatio = (lm[473].x - lm[362].x) / lDen;
    return (rRatio + lRatio) / 2;
  }
  function faceMetrics(result) {
    const m = result.facialTransformationMatrixes?.[0]?.data;
    if (!m) return null;
    const deg = 180 / Math.PI;
    const yaw = Math.atan2(-m[2], Math.hypot(m[6], m[10])) * deg;
    const pitch = Math.atan2(m[6], m[10]) * deg;
    const irisX = irisHorizontalRatio(result.faceLandmarks?.[0]);
    return { yaw, pitch, irisX: irisX ?? 0.5 };
  }
  function duplicatePerson(a, b) {
    const width = Math.max(
      0,
      Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x),
    );
    const height = Math.max(
      0,
      Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y),
    );
    const both = width * height;
    return (
      both / (a.w * a.h + b.w * b.h - both || 1) > 0.4 ||
      both / Math.min(a.w * a.h, b.w * b.h) > 0.65
    );
  }
  class ExamEdge {
    constructor(video, options = {}) {
      this.video = video;
      this.options = options;
      this.sensitive = options.sensitivity === "sensitive";
      this.controller = new AbortController();
      this.timers = [];
      this.last = {};
      this.photoLast = {};
      this.counts = {};
      this.objHits = {};
      this.locks = new Set();
      this.flags = [];
      this.trackBad = {};
      this.paused = false;
      this.sample = document.createElement("canvas");
      this.sample.width = 32;
      this.sample.height = 24;
      this.sampleCtx = this.sample.getContext("2d", {
        willReadFrequently: true,
      });
    }
    progress(message) {
      this.options.onProgress?.(message);
    }
    pause() {
      this.paused = true;
    }
    resume() {
      this.paused = false;
    }
    async attach(video) {
      this.video = video;
      video.muted = true;
      video.playsInline = true;
      video.srcObject = this.stream;
      await video.play();
    }
    async devices() {
      if (!navigator.mediaDevices?.getUserMedia)
        throw Error(
          "Open the examination over HTTPS or localhost to enable camera access.",
        );
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          facingMode: "user",
        },
        audio: {
          echoCancellation: true,
          noiseSuppression: false,
          autoGainControl: true,
          channelCount: 1,
        },
      });
      if (this.controller.signal.aborted) {
        stream.getTracks().forEach((t) => t.stop());
        throw Error("Check cancelled");
      }
      this.releaseDevices();
      this.stream = stream;
      await this.attach(this.video);
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      try {
        this.audio = new AudioCtx({ sampleRate: 16000 });
      } catch {
        this.audio = new AudioCtx();
      }
      await this.audio.resume();
      const [module] = await Promise.all([
        fetch("/vendor/libfvad/libfvad.wasm", {
          signal: this.controller.signal,
        }).then(async (r) => {
          if (!r.ok) throw Error("Could not load the microphone check.");
          return WebAssembly.compile(await r.arrayBuffer());
        }),
        this.audio.audioWorklet.addModule("/speech-monitor.js"),
      ]);
      this.controller.signal.throwIfAborted();
      this.voiceNode = new AudioWorkletNode(this.audio, "exam-speech-monitor", {
        processorOptions: { module, mode: this.sensitive ? 0 : 1 },
      });
      this.inputHistory = [];
      this.flags = [];
      this.burst = 0;
      this.burstPeak = 0;
      this.lastVoice = 0;
      this.sustained = false;
      this.lastPacket = performance.now();
      this.voiceNode.port.onmessage = ({ data }) => {
        this.lastPacket = performance.now();
        this.inputHistory.push(data);
        if (this.inputHistory.length > 40) this.inputHistory.shift();
        if (this.running && !this.recovering && !this.paused)
          this.audioCheck(data);
      };
      this.source = this.audio.createMediaStreamSource(stream);
      this.source.connect(this.voiceNode);
      this.voiceNode.connect(this.audio.destination);
      this.objHits = {};
      this.lastObjectFrame = null;
      this.lastFaceFrame = null;
      this.previousPixels = null;
      this.frameBad = null;
      this.frameLost = false;
      this.trackBad = {};
    }
    releaseDevices() {
      this.stream?.getTracks().forEach((track) => track.stop());
      this.source?.disconnect();
      this.voiceNode?.port.close();
      this.voiceNode?.disconnect();
      if (this.audio && this.audio.state !== "closed")
        this.audio.close().catch(() => {});
    }
    pixels() {
      this.sampleCtx.drawImage(this.video, 0, 0, 32, 24);
      const data = this.sampleCtx.getImageData(0, 0, 32, 24).data;
      let luma = 0,
        same = !!this.previousPixels;
      for (let i = 0; i < data.length; i += 4) {
        luma += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
        if (
          same &&
          (data[i] !== this.previousPixels[i] ||
            data[i + 1] !== this.previousPixels[i + 1] ||
            data[i + 2] !== this.previousPixels[i + 2])
        )
          same = false;
      }
      this.previousPixels = data;
      return { luma: luma / (32 * 24), same };
    }
    async calibrateAudio() {
      this.inputHistory = [];
      await sleep(1200);
      this.controller.signal.throwIfAborted();
      const levels = this.inputHistory.map((p) => p.rms).sort((a, b) => a - b);
      if (levels.length < 4)
        throw Error(
          "No microphone samples received. Select a working input device and retry.",
        );
      this.noiseRms = levels[Math.floor(levels.length * 0.2)];
      this.voiceNode.port.postMessage({
        floor: Math.max(0.0012, Math.min(0.008, this.noiseRms * 1.5)),
      });
    }
    async verifyMicrophone() {
      this.progress("Microphone check: say a short sentence aloud.");
      this.inputHistory = [];
      const until = performance.now() + 15000;
      while (performance.now() < until) {
        this.controller.signal.throwIfAborted();
        if (this.inputHistory.reduce((sum, p) => sum + p.voiceMs, 0) >= 300)
          return;
        await sleep(100);
      }
      throw Error(
        "Speech was not picked up. Check your microphone selection and input volume, then repeat the check.",
      );
    }
    async loadTask(Task, modelAssetPath, options, signal) {
      const response = await fetch(models + modelAssetPath, { signal });
      if (!response.ok)
        throw Error("Model download failed (" + response.status + ")");
      const modelAssetBuffer = new Uint8Array(await response.arrayBuffer());
      for (const delegate of ["GPU", "CPU"]) {
        signal.throwIfAborted();
        let task;
        try {
          task = await Task.createFromOptions(this.vision, {
            ...options,
            runningMode: "VIDEO",
            baseOptions: { modelAssetBuffer, delegate },
          });
          signal.throwIfAborted();
          task.detectForVideo(this.video, performance.now());
          return task;
        } catch (error) {
          task?.close();
          if (delegate === "CPU" || signal.aborted) throw error;
        }
      }
    }
    async loadObject(Task) {
      const options = { scoreThreshold: 0.16, maxResults: 10 };
      const start = performance.now();
      for (const [path, limit] of [
        ["efficientdet_lite2/float16/1/efficientdet_lite2.tflite", 10000],
        ["efficientdet_lite0/int8/1/efficientdet_lite0.tflite", 16000],
      ]) {
        const cancel = new AbortController();
        const abort = () => cancel.abort();
        this.controller.signal.addEventListener("abort", abort, { once: true });
        let timeout;
        try {
          return await Promise.race([
            this.loadTask(
              Task,
              "object_detector/" + path,
              options,
              cancel.signal,
            ),
            new Promise((_, reject) => {
              timeout = setTimeout(
                () => {
                  cancel.abort();
                  reject(Error("Object model timed out"));
                },
                Math.max(0, limit - (performance.now() - start)),
              );
            }),
          ]);
        } catch (error) {
          this.controller.signal.throwIfAborted();
        } finally {
          clearTimeout(timeout);
          this.controller.signal.removeEventListener("abort", abort);
        }
      }
      return null;
    }
    async prepare() {
      try {
        this.progress("Checking camera & microphone...");
        await this.devices();
        this.progress("Loading proctoring checks...");
        const { FilesetResolver, FaceLandmarker, ObjectDetector } =
          await import(cdn + "/vision_bundle.mjs");
        this.vision = await FilesetResolver.forVisionTasks(cdn + "/wasm");
        this.face = await this.loadTask(
          FaceLandmarker,
          "face_landmarker/face_landmarker/float16/1/face_landmarker.task",
          {
            numFaces: 4,
            outputFaceBlendshapes: true,
            outputFacialTransformationMatrixes: true,
            minFaceDetectionConfidence: 0.3,
            minFacePresenceConfidence: 0.3,
            minTrackingConfidence: 0.3,
          },
          this.controller.signal,
        );
        this.object = await this.loadObject(ObjectDetector);
        const baseline = [];
        const start = performance.now();
        let lastFrame = -1,
          multipleVisible = false;
        this.progress("Measuring room noise. Please stay quiet for a moment.");
        await this.calibrateAudio();
        while (baseline.length < 6) {
          this.controller.signal.throwIfAborted();
          if (performance.now() - start > 60000)
            throw Error("Face the camera in good light and repeat the check.");
          if (
            this.video.currentTime !== lastFrame &&
            this.pixels().luma >= 8
          ) {
            lastFrame = this.video.currentTime;
            const result = this.face.detectForVideo(
              this.video,
              performance.now(),
            );
            if (result.faceLandmarks.length > 1) multipleVisible = true;
            if (result.faceLandmarks.length === 1) {
              multipleVisible = false;
              const metrics = faceMetrics(result);
              if (metrics) baseline.push(metrics);
            }
          }
          this.progress(
            multipleVisible
              ? "Only one person must be visible in front of the camera."
              : "Calibrating baseline (" + baseline.length + "/6)...",
          );
          await sleep(250);
        }
        this.base = Object.fromEntries(
          Object.keys(baseline[0]).map((k) => [
            k,
            mean(baseline.map((x) => x[k])),
          ]),
        );
        if (
          this.stream
            .getTracks()
            .some((t) => t.muted || t.readyState !== "live") ||
          this.audio.state !== "running" ||
          this.pixels().luma < 8
        )
          throw Error(
            "Camera and microphone must remain active. Repeat the check.",
          );
        await this.verifyMicrophone();
        this.progress("Ready");
        this.ready = true;
        return {
          models_loaded: { face: true, object: !!this.object, audio: true },
        };
      } catch (error) {
        this.stop();
        throw error;
      }
    }
    async fullscreen() {
      if (!document.fullscreenElement)
        await document.documentElement.requestFullscreen();
      if (!document.fullscreenElement)
        throw Error("Fullscreen is required to begin.");
      this.checkScreen();
      if (this.locks.has("fullscreen"))
        throw Error("Expand the examination window to fill the screen.");
    }
    photo() {
      return captureAnnotatedSnapshot(this.video);
    }
    emit(
      modality,
      type,
      severity,
      confidence,
      details = {},
      boxes = [],
      title = "",
      seconds = cooldown[type],
    ) {
      if (!this.running || this.paused) return;
      const now = performance.now();
      if (now - (this.last[type] ?? -Infinity) < seconds * 1000) return;
      this.last[type] = now;
      let snapshot = null;
      const gap =
        type === "head_turn" ? 15000 : type === "sustained_speech" ? 18000 : 0;
      if (
        snapshotTypes.has(type) &&
        now - (this.photoLast[type] ?? -Infinity) >= gap
      ) {
        snapshot = captureAnnotatedSnapshot(
          this.video,
          boxes,
          title || type.replaceAll("_", " ").toUpperCase(),
        );
        if (snapshot) this.photoLast[type] = now;
      }
      this.options.onEvent?.({
        modality,
        event_type: type,
        severity,
        confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
        details,
        snapshot,
      });
    }
    streak(key, truth) {
      return (this.counts[key] = truth ? (this.counts[key] || 0) + 1 : 0);
    }
    trackHit(key, now, windowMs) {
      const list = (this.objHits[key] || []).filter((t) => now - t <= windowMs);
      list.push(now);
      this.objHits[key] = list;
      return list.length;
    }
    faceCheck(now) {
      if (this.lastFaceFrame === this.video.currentTime) return;
      this.lastFaceFrame = this.video.currentTime;
      const r = this.face.detectForVideo(this.video, now),
        faces = r.faceLandmarks;
      const boxes = faces.map((f, i) => ({
        ...bounds(f, this.video),
        label: "FACE " + (i + 1),
      }));

      if (this.streak("absent", !faces.length) >= 6)
        this.emit(
          "video",
          "no_face_detected",
          "high",
          1,
          { consecutive_checks: this.counts.absent },
          [],
          "NO FACE DETECTED",
        );
      const multiple = this.streak("multi", faces.length > 1);
      if (
        multiple >= 2 ||
        boxes.filter((b) => b.w >= this.video.videoWidth * 0.07).length >= 2
      )
        this.emit(
          "video",
          "multiple_faces",
          "high",
          1,
          { count: faces.length },
          boxes,
          "MULTIPLE FACES",
        );
      if (faces.length !== 1) {
        this.counts.pose = 0;
        this.counts.gaze = 0;
        return;
      }
      const m = faceMetrics(r);
      if (!m) return;

      const yaw = m.yaw - this.base.yaw,
        pitch = m.pitch - this.base.pitch;
      const yawLimit = this.sensitive ? 16 : 20,
        pitchLimit = this.sensitive ? 14 : 18;
      const turned = Math.abs(yaw) > yawLimit || Math.abs(pitch) > pitchLimit;
      if (this.streak("pose", turned) >= 4) {
        const direction =
          Math.abs(yaw) / yawLimit >= Math.abs(pitch) / pitchLimit
            ? yaw > 0
              ? "LEFT"
              : "RIGHT"
            : pitch > 0
              ? "DOWN"
              : "UP";
        const title = "HEAD TURN " + direction;
        this.emit(
          "video",
          "head_turn",
          "medium",
          Math.min(1, Math.max(Math.abs(yaw) / 75, Math.abs(pitch) / 75)),
          {
            direction,
            yaw_deg: Number(yaw.toFixed(1)),
            pitch_deg: Number(pitch.toFixed(1)),
          },
          [{ ...boxes[0], label: title }],
          title,
        );
      }

      const map = Object.fromEntries(
        (r.faceBlendshapes?.[0]?.categories || []).map((c) => [
          c.categoryName,
          c.score,
        ]),
      );
      const gazeScores = [
        { dir: "LEFT", score: ((map.eyeLookOutLeft || 0) + (map.eyeLookInRight || 0)) / 2 },
        { dir: "RIGHT", score: ((map.eyeLookOutRight || 0) + (map.eyeLookInLeft || 0)) / 2 },
        { dir: "UP", score: ((map.eyeLookUpLeft || 0) + (map.eyeLookUpRight || 0)) / 2 },
        { dir: "DOWN", score: ((map.eyeLookDownLeft || 0) + (map.eyeLookDownRight || 0)) / 2 },
      ].sort((a, b) => b.score - a.score);
      const bestGaze = gazeScores[0];
      const irisDelta = m.irisX - (this.base.irisX ?? 0.5);
      const irisLimit = this.sensitive ? 0.14 : 0.18;
      const gazeLimit = this.sensitive ? 0.36 : 0.44;
      const gazeAway =
        !turned && (bestGaze.score > gazeLimit || Math.abs(irisDelta) > irisLimit);
      if (this.streak("gaze", gazeAway) >= 4) {
        const direction =
          bestGaze.score > gazeLimit
            ? bestGaze.dir
            : irisDelta > 0
              ? "LEFT"
              : "RIGHT";
        const score = Math.max(
          bestGaze.score,
          Math.min(0.95, Math.abs(irisDelta) * 3),
        );
        this.emit("video", "eye_gaze_away", "low", score, {
          direction,
          score: Number(score.toFixed(2)),
        });
      }
    }
    objectCheck(now) {
      if (this.lastObjectFrame === this.video.currentTime) return;
      this.lastObjectFrame = this.video.currentTime;
      let phone = null,
        remote = null,
        book = null,
        secondScreen = null;
      const people = [];
      const detections = this.object.detectForVideo(this.video, now).detections;
      const frameArea = this.video.videoWidth * this.video.videoHeight;
      const phoneMin = this.sensitive ? 0.22 : 0.28;
      const remoteMin = this.sensitive ? 0.34 : 0.4;
      const bookMin = this.sensitive ? 0.3 : 0.36;
      const personMin = this.sensitive ? 0.48 : 0.54;

      for (const d of detections) {
        const c = d.categories[0],
          b = d.boundingBox;
        if (!b || !c || b.width <= 0 || b.height <= 0) continue;
        const name = c.categoryName,
          score = c.score,
          box = { x: b.originX, y: b.originY, w: b.width, h: b.height, score };
        if (name === "person" && score >= personMin && box.w * box.h >= 0.035 * frameArea)
          people.push(box);
        if (name === "cell phone" && score >= phoneMin && (!phone || score > phone.score))
          phone = box;
        if (name === "remote" && score >= remoteMin && (!remote || score > remote.score))
          remote = box;
        if (name === "book" && score >= bookMin && (!book || score > book.score))
          book = box;
        if (name === "laptop" && score >= 0.45 && (!secondScreen || score > secondScreen.score))
          secondScreen = box;
      }

      if (phone) {
        const hits = this.trackHit("cell_phone", now, 1600);
        if (phone.score >= 0.4 || hits >= 2)
          this.emit(
            "video",
            "phone_detected",
            "high",
            phone.score,
            { detected_class: "cell phone", hits },
            [{ ...phone, label: "PHONE " + percent(phone.score) }],
            "PHONE DETECTED",
          );
      } else if (remote) {
        const hits = this.trackHit("remote", now, 1600);
        if (hits >= 2)
          this.emit(
            "video",
            "phone_detected",
            "high",
            remote.score,
            { detected_class: "handheld/remote", hits },
            [{ ...remote, label: "PHONE/HANDHELD " + percent(remote.score) }],
            "PHONE DETECTED",
          );
      } else if (secondScreen) {
        const hits = this.trackHit("laptop", now, 1800);
        if (hits >= 2)
          this.emit(
            "video",
            "phone_detected",
            "high",
            secondScreen.score,
            { detected_class: "second screen/device", hits },
            [{ ...secondScreen, label: "DEVICE " + percent(secondScreen.score) }],
            "SECOND DEVICE DETECTED",
          );
      }

      if (book) {
        const hits = this.trackHit("book", now, 1800);
        if (book.score >= 0.48 || hits >= 2)
          this.emit(
            "video",
            "book_detected",
            "medium",
            book.score,
            { detected_class: "book", hits },
            [{ ...book, label: "BOOK " + percent(book.score) }],
            "BOOK DETECTED",
          );
      }

      const unique = [];
      for (const box of people.sort((a, b) => b.score - a.score))
        if (!unique.some((other) => duplicatePerson(box, other)))
          unique.push(box);
      if (
        this.streak("people", unique.length >= 2) >= 2 ||
        unique.some(
          (a, i) =>
            a.score >= 0.68 &&
            unique.slice(i + 1).some((b) => {
              const dx = Math.abs(a.x + a.w / 2 - b.x - b.w / 2),
                dy = Math.abs(a.y + a.h / 2 - b.y - b.h / 2);
              return (
                b.score >= 0.68 &&
                dx >= 0.18 * this.video.videoWidth &&
                (dx > Math.max(a.w, b.w) / 2 || dy > Math.max(a.h, b.h) / 2)
              );
            }),
        )
      ) {
        const boxes = unique.map((box, i) => ({
          ...box,
          label: "PERSON " + (i + 1) + " " + percent(box.score),
        }));
        this.emit(
          "video",
          "multiple_persons",
          "high",
          unique[1].score,
          { count: unique.length },
          boxes,
          "MULTIPLE PERSONS",
        );
      }
    }
    audioCheck({ at, voiceMs, rms }) {
      if (Math.abs(this.audio.currentTime * 1000 - at) > 2000) return;
      this.flags = this.flags.filter((p) => at - p.at < 2500);
      const sustainedMs = this.sensitive ? 750 : 950;
      const briefMs = this.sensitive ? 280 : 360;
      if (voiceMs > 0) {
        this.flags.push({ at, voiceMs });
        this.lastVoice = at;
        this.burst += voiceMs;
        this.burstPeak = Math.max(this.burstPeak, rms);
        const total = this.flags.reduce((s, p) => s + p.voiceMs, 0);
        if (total >= sustainedMs && !this.sustained) {
          this.sustained = true;
          this.emit(
            "audio",
            "sustained_speech",
            "medium",
            Math.min(1, Math.max(0.55, total / 1800)),
            {
              detector: "WebRTC VAD",
              voice_ms: total,
              window_ms: 2500,
              rms: Number(this.burstPeak.toFixed(4)),
            },
            [],
            "SUSTAINED SPEECH",
          );
        }
      } else if (this.lastVoice && at - this.lastVoice >= 350) {
        if (!this.sustained && this.burst >= briefMs) {
          this.emit("audio", "brief_ambient_sound", "low", 0.55, {
            detector: "WebRTC VAD",
            voice_ms: this.burst,
            rms: Number(this.burstPeak.toFixed(4)),
          });
        }
        this.burst = 0;
        this.burstPeak = 0;
        this.sustained = false;
      }
    }
    lock(reason, active) {
      if (active) this.locks.add(reason);
      else this.locks.delete(reason);
      const selected =
        ["fullscreen", "camera", "microphone"].find((r) => this.locks.has(r)) ||
        null;
      if (selected !== this.previousLock) {
        this.previousLock = selected;
        this.options.onLock?.(selected);
      }
    }
    checkScreen() {
      if (this.paused) return;
      const lost =
        !document.fullscreenElement ||
        window.innerWidth < screen.availWidth * 0.82 ||
        window.innerHeight < screen.availHeight * 0.78;
      this.lock("fullscreen", lost);
      if (lost && !this.screenWasLost)
        this.emit("browser", "fullscreen_exit", "medium", 1, {
          fullscreen: !!document.fullscreenElement,
          width: innerWidth,
          height: innerHeight,
        });
      this.screenWasLost = lost;
    }
    hardware(now) {
      if (this.paused) return;
      if (this.audio && this.audio.state === "suspended") {
        this.audio.resume().catch(() => {});
      }
      if (this.video.readyState >= 2) {
        const { luma, same } = this.pixels();
        if (luma < 8 || same) this.frameBad ??= now;
        else this.frameBad = null;
        this.frameLost = this.frameBad !== null && now - this.frameBad >= 3000;
      } else {
        this.frameBad ??= now;
        this.frameLost = now - this.frameBad >= 3000;
      }
      for (const [kind, reason] of [
        ["video", "camera"],
        ["audio", "microphone"],
      ]) {
        const track = this.stream.getTracks().find((t) => t.kind === kind);
        const bad =
          !track ||
          track.readyState !== "live" ||
          track.muted ||
          !track.enabled ||
          (kind === "audio" &&
            (this.audio.state !== "running" || now - this.lastPacket > 3000));
        if (bad) this.trackBad[kind] ??= now;
        else this.trackBad[kind] = null;
        const lost =
          (bad && now - this.trackBad[kind] >= 2500) ||
          (kind === "video" && this.frameLost);
        this.lock(reason, lost);
        if (lost)
          this.emit(kind, reason + "_lost", "medium", 1, {
            reason: bad ? "track_unavailable" : "dark_or_frozen_frame",
          });
      }
    }
    async recover() {
      if (this.recovering) return;
      this.recovering = true;
      try {
        await this.devices();
        await this.calibrateAudio();
        this.hardware(performance.now());
        if (this.video.readyState < 2 || this.pixels().luma < 8)
          this.lock("camera", true);
      } finally {
        this.recovering = false;
      }
    }
    every(ms, fn, channel) {
      let busy = false;
      this.timers.push(
        setInterval(() => {
          if (
            busy ||
            !this.running ||
            this.paused ||
            (this.recovering && channel !== "browser")
          )
            return;
          busy = true;
          try {
            fn(performance.now());
          } catch (error) {
            this.emit(channel, "monitoring_gap", "medium", 1, {
              reason: "check_error",
              check: fn.name,
              error: String(error.name),
            });
          } finally {
            busy = false;
          }
        }, ms),
      );
    }
    start() {
      if (!this.ready)
        throw Error("Complete the equipment check before beginning.");
      if (this.running) return;
      this.running = true;
      this.paused = false;
      if (this.audio && this.audio.state === "suspended") {
        this.audio.resume().catch(() => {});
      }
      if (!this.object)
        this.emit("video", "monitoring_gap", "medium", 1, {
          reason: "object_model_unavailable",
        });
      this.every(
        250,
        (now) => {
          if (this.video.readyState >= 2) this.faceCheck(now);
        },
        "video",
      );
      if (this.object)
        this.every(
          350,
          (now) => {
            if (this.video.readyState >= 2) this.objectCheck(now);
          },
          "video",
        );

      this.every(2000, (now) => this.hardware(now), "video");
      this.every(2000, () => this.checkScreen(), "browser");
      this.checkScreen();
      let lastTick = Date.now();
      this.every(
        3000,
        () => {
          const now = Date.now(),
            elapsed = now - lastTick;
          lastTick = now;
          if (elapsed > 7500)
            this.emit("browser", "monitoring_gap", "medium", 1, {
              elapsed_ms: elapsed,
            });
        },
        "browser",
      );
      const on = (target, type, handler) =>
        target.addEventListener(type, handler, {
          capture: true,
          signal: this.controller.signal,
        });
      on(document, "fullscreenchange", () => this.checkScreen());
      on(document, "visibilitychange", () => {
        if (document.hidden && !this.paused) {
          this.tabTime = performance.now();
          this.emit("browser", "tab_switch", "medium", 1);
        }
      });
      let blurTimer;
      on(window, "focus", () => clearTimeout(blurTimer));
      on(window, "blur", () => {
        clearTimeout(blurTimer);
        if (this.paused) return;
        const at = performance.now();
        blurTimer = setTimeout(() => {
          if (
            !this.paused &&
            !document.hidden &&
            !document.hasFocus() &&
            !document.querySelector("dialog[open]") &&
            !this.locks.size &&
            Math.abs(at - (this.tabTime ?? -Infinity)) > 2000
          )
            this.emit("browser", "window_blur", "low", 1);
        }, 2000);
      });
      for (const type of ["copy", "cut", "paste", "drop", "contextmenu"])
        on(document, type, (e) => {
          e.preventDefault();
          this.emit(
            "browser",
            type === "contextmenu" ? "context_menu" : "copy_paste",
            type === "contextmenu" ? "low" : "medium",
            1,
            { action: type },
          );
        });
      on(document, "keydown", (e) => {
        const key = e.key.toLowerCase(),
          mod = e.ctrlKey || e.metaKey;
        const block =
          ["f12", "printscreen"].includes(key) ||
          (mod && ["c", "v", "x", "a", "p", "s", "u"].includes(key)) ||
          (mod && e.shiftKey && ["i", "j", "c", "k"].includes(key));
        if (block) {
          e.preventDefault();
          if (e.repeat) return;
          const clipboard = mod && ["c", "v", "x"].includes(key) && !e.shiftKey;
          this.emit(
            "browser",
            clipboard ? "copy_paste" : "blocked_shortcut",
            clipboard ? "medium" : "low",
            1,
            { key, shift: e.shiftKey, modifier: mod },
          );
        }
      });
    }
    stop() {
      this.running = false;
      this.paused = false;
      this.ready = false;
      this.controller.abort();
      this.timers.forEach(clearInterval);
      this.timers = [];
      this.face?.close();
      this.object?.close();
      this.face = null;
      this.object = null;
      this.releaseDevices();
      if (this.video) this.video.srcObject = null;
    }
  }
  window.captureAnnotatedSnapshot = captureAnnotatedSnapshot;
  window.ExamEdge = ExamEdge;
})();