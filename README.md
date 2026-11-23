---
title: Exam Monitor
emoji: 🎓
colorFrom: blue
colorTo: indigo
sdk: gradio
app_file: server.py
pinned: false
---

# Exam Monitor

Exam Monitor runs timed MCQ and written examinations with browser-side camera and audio checks. Students register, calibrate their devices, take the exam in fullscreen, and receive a submission receipt. Proctors configure the assessment, review observations alongside the captured evidence, grade against the original questions, and export results.

## Start on Windows

Extract the ZIP into a writable folder. Double-click **START.bat**. On the first launch, the launcher creates a virtual environment using Python 3.11, 3.12 or 3.13 and installs dependencies. This step needs internet access. The launcher opens the student portal in your default browser when the server is ready. Keep the terminal open while using the app.

For the proctor workspace, follow **Proctor portal** or visit [the local proctor portal](http://127.0.0.1:7860/proctor). A fresh local database offers **Set up proctor** there. Students use an 11-digit roll number. Use a separate browser profile to test both roles.

Double-click **EDIT_API_KEY.bat** to open the actual configuration file in Notepad. Paste your Gemini key after `GEMINI_API_KEY=`, save, close the running server and start it again. An optional `PROCTOR_PIN=` enables a second proctor sign-in field. Exam delivery and local reports work without a Gemini key.

For an existing installation, stop the server and copy the updated package contents into the existing application folder. Keep your local `exam.db` and `.env`. Both files are excluded from the ZIP. The desktop launcher binds to loopback with one worker. The cloud entrypoint uses two workers.

## Host on a Space

Create a Blank Gradio Space using free CPU hardware. Copy the contents of this directory to its repository root. The frontmatter selects `server.py`, which runs two Uvicorn workers on port 7860. Use a Python 3.11 runtime. When choosing the runtime through README metadata, add `python_version: "3.11"` under `sdk`. Set the following in the Space settings before the first launch.

| Setting | Purpose |
| --- | --- |
| `DATABASE_URL` | Pooled PostgreSQL connection string from Neon or Supabase, with TLS enabled. Each worker can open up to 12 connections to the pooler. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | First cloud proctor login. Choose a unique password of at least eight characters and store it as a secret. |
| `ADMIN_DISPLAY_NAME` | Display name for the seeded proctor. |
| `PUBLIC_BASE_URL` | Public HTTPS origin of the running application. |
| `EXAM_ACCESS_CODE` | Optional fallback student registration code. The exam settings form can supply a different code. |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Optional Gemini credentials and model override for proctor-initiated analysis. |
| `MAX_EVIDENCE_PER_SESSION` | Retained JPEGs per session, including the reference image. Default 15, minimum 7. |

Open the Space's direct HTTPS app URL for the exam so camera, microphone, fullscreen and session cookies can operate in a first-party browser context. The browser downloads MediaPipe Tasks Vision and the models during pre-check. Allow the model and script hosts on the examination network. For deployments using the Docker SDK, change the metadata to `sdk: docker` and use the included Dockerfile. On a Docker host, build with `docker build -t exam-monitor .` and run `docker run --env-file .env -p 7860:7860 exam-monitor`. Place the container behind a reverse proxy that overwrites incoming forwarding headers and terminates TLS. [Spaces configuration reference](https://huggingface.co/docs/hub/spaces-config-reference)

PostgreSQL holds exam definitions, frozen question sets, answers, reports, reference photos, and evidence. The SQLite fallback is intended for a persistent local disk. At the configured maximum, 250 sessions × 15 images × 150 KiB is about 549 MiB of image data alone. Check the database's available space before an exam. Observed JPEG sizes, retention between cohorts, provider quotas and network latency determine the capacity of a free deployment.

## Run an examination

1. In **Exam & Questions**, set a title and duration, add or import the questions, and select each MCQ answer. MCQ indexes in JSON start at zero. Changes lock while an attempt is active. A new exam title permits a new attempt.
2. Students register, sign in, grant camera and microphone access, calibrate, and enter fullscreen. Resuming with the same login and exam title restores the attempt. Use the same browser profile to recover locally pending answers after a connection interruption.
3. In **Monitor & Reports**, select a session to see its observations and evidence. On submission the local engine scores the frozen record immediately. Use **Run fusion analysis** for an optional Gemini narrative or **Open report** to review individual answers and print.
4. Download the CSV to export the cohort's MCQ results and written responses. Review observations in context. Lighting affects face tracking, and detected speech can come from another person or a loudspeaker. A review score alone cannot establish misconduct.

## Data flow

Camera frames and microphone samples are processed in the browser. The application sends reference and selected event JPEGs, observation metadata, and answers to the exam server. Raw microphone audio stays on the student's device. Students can read their own questions and answers. The server restricts evidence, grading keys, exports, and reports to proctors. Manual Gemini fusion sends a report summary and answer verification sends the question and written answer to the configured provider.

## Monitor checks

During pre-check, keep the room quiet for the baseline, then say a short sentence when prompted. The exam opens after the microphone supplies enough speech-like audio to pass the check. If it times out, choose the intended microphone in the browser's site settings and repeat the check. Speech checks run locally on the audio rendering thread using the bundled WebRTC VAD (libfvad WASM). Raw audio is never uploaded. Proctors can inspect the duration of detected voice activity.

Phone observations require three successive matching cell-phone detections on different frames. This reduces isolated false alerts and can miss very short appearances. Remote controls do not count as phones. The multiple-face observation requires multiple visible faces. A single face turning in profile cannot trigger a geometry-based identity-swap observation. Old records retain the rules and scores used when captured.

The speech detector is bundled from `@ozymandiasthegreat/vad` version 2.0.7. Its license, authors and patent notices are included in `app/static/vendor/libfvad/`. [Upstream project](https://github.com/OzymandiasTheGreat/libfvad-wasm)

## Verification

The final in-process test used Python 3.13.5, the pinned application dependencies and temporary SQLite storage. All 250 attempts completed, with 1,753 requests, zero errors, p50 of 1,712.7 ms and p95 of 5,179.1 ms. Twelve pytest tests passed. Channel regression checks cover phone confirmation, a head turn following a tracking gap, repeated fullscreen events, isolated clicks and silence. For the recorded speech regression, set VAD_TEST_WAV to libfvad's tests/data/audio_tiny48.wav before running the Node test. The bundled detector passed at the original recording level and at one-tenth amplitude. These results cover the sampled inputs. Physical microphone and webcam performance varies by device and room.

The updated desktop launcher returned HTTP 200 for the student portal, proctor portal and authentication status. The browser-opening call was checked using a test substitute. The two-worker Windows launch encountered a multiprocessing named-pipe error, and the preview browser could not reach the isolated server. To run locally in a similarly restricted environment, use `python -m uvicorn app.main:app --host 127.0.0.1 --port 7860`. The supplied server entrypoint keeps two workers for deployment. Hosted PostgreSQL, live Gemini, physical camera and microphone detection, and public deployment capacity still require staging verification.

Run these commands from this directory after activating the Python environment.

```console
python -m pytest -q
python -m compileall -q app server.py tests load_test_250.py smoke_ai.py
node --check app/static/app.js
node --check app/static/edge-ai.js
node --test tests/channels.test.cjs
python load_test_250.py --in-process --students 250
python smoke_ai.py --help
```

`TEST_250.bat` runs the in-process load driver using an isolated, temporary SQLite database. For a deployed staging service, inspect `python load_test_250.py --help` and use `--base-url` with that service's URL. The remote test creates real student accounts, attempts, and evidence. A staging run measures the two workers, public network, proxy, and PostgreSQL pooler together. Neither load mode measures browser model accuracy. For that, use representative student PCs, real devices, lighting conditions and network connections.
