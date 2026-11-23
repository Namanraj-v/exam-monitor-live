# Exam Monitor Live

Exam Monitor Live is a browser-based platform for timed online exams. Students take multiple-choice and written assessments with camera and microphone checks. Proctors build exams, review submissions and monitoring evidence, and export results from a separate dashboard.

## Live deployment

The hosted application runs on **Render** with **Neon PostgreSQL** for persistent storage. Open the service’s public `https://…onrender.com` URL directly in a browser.

| Portal | Address | Access |
| --- | --- | --- |
| Student | Root of the public URL (`/`) | Student account and the exam access code, if configured |
| Proctor | Public URL followed by `/proctor` | Proctor credentials and an optional PIN |

Share the student URL and exam access code with the cohort. Keep proctor credentials private.

## Features

- **Exam builder** with configurable duration, marks, MCQ answer keys, written questions, optional question images, and bulk JSON import.
- **Student exam flow** with device calibration, fullscreen, a countdown, attempt recovery, and a submission receipt.
- **Browser-based monitoring** with face, phone, voice-activity, and fullscreen observations for proctor review.
- **Results and reports** with automatic MCQ scoring, written-answer review, printable reports, and CSV export.
- **Optional Gemini analysis** initiated by a proctor. Core exam delivery, scoring, and reports work without a Gemini key.

## Run an exam

### For proctors

1. Sign in at `/proctor` and open **Exam & Questions**.
2. Set the exam title, duration, and student access code. Add or import questions and check the MCQ answer keys before sharing the exam. Exam settings and questions are locked while an attempt is active.
3. Complete a practice attempt on a representative student device. Check camera and microphone permissions, fullscreen, the submission receipt, and the exported result.
4. During and after the exam, open **Monitor & Reports** to review attempts, inspect observations and evidence, review written responses, and export the results CSV.

### For students

1. Open the student link in a regular browser tab. Register with your 11-digit roll number and the exam access code if prompted, then sign in.
2. Allow camera and microphone access. Follow the on-screen calibration steps and enter fullscreen when prompted.
3. Answer the questions and submit before time expires. Check that the submission receipt appears. If disconnected, reopen the same link in the same browser profile and sign in with the same account to resume the attempt or recover locally pending answers.

### Import questions

In **Exam & Questions**, paste a JSON array into the import form. Choose `append` to add questions to the current list or `replace` to replace the entire list. `correct_option` is zero-based, so `1` selects the second choice.

```json
[
  {
    "type": "mcq",
    "text": "Which protocol encrypts traffic between a browser and a web server?",
    "options": ["HTTP", "HTTPS", "FTP", "SMTP"],
    "correct_option": 1,
    "marks": 2
  },
  {
    "type": "subjective",
    "text": "Explain one reason to back up a database.",
    "marks": 3
  }
]
```

## Run locally

Clone this repository or download and extract the source ZIP into a writable directory.

**Windows**

1. Install Python 3.11, 3.12, or 3.13.
2. Double-click [`START.bat`](START.bat). The first run installs the dependencies and needs internet access.
3. Open the [student portal](http://127.0.0.1:7860/) or the [proctor portal](http://127.0.0.1:7860/proctor). On a fresh local database, select **Set up proctor**.

**Manual setup**

Activate a Python virtual environment, then run these commands from the repository root.

```sh
python -m pip install -r requirements.txt
python -m uvicorn app.main:app --host 127.0.0.1 --port 7860
```

Local runs use SQLite when `DATABASE_URL` is unset. Back up `exam.db` and your `.env` before replacing an existing local installation.

## Deploy on Render with Neon

1. Create a Neon PostgreSQL project. In **Connect**, enable connection pooling and copy the full TLS-enabled `postgresql://…` URL. [Neon connection guide](https://neon.com/docs/connect/connect-from-any-app)
2. In Render, create a **Web Service** from this GitHub repository. Select branch `main`, choose **Docker**, and use the root [`Dockerfile`](Dockerfile). The container starts Uvicorn through [`server.py`](server.py), which reads the platform’s `PORT`. [Render Docker guide](https://render.com/docs/docker)
3. Set `DATABASE_URL`, `ADMIN_USERNAME`, and `ADMIN_PASSWORD` in the service’s **Environment** tab. When Render assigns the public address, set `PUBLIC_BASE_URL` to the exact HTTPS origin and deploy the change. Store credentials in Render’s environment settings. [Render environment guide](https://render.com/docs/configure-environment-variables)
4. Open the public root URL and `/proctor` to verify both portals before distributing the student link.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Pooled PostgreSQL connection URL with TLS enabled. Set this for hosted deployments. |
| `ADMIN_USERNAME` | Username for the initial proctor account. |
| `ADMIN_PASSWORD` | Initial proctor password. Use a unique password of at least eight characters. |
| `PUBLIC_BASE_URL` | Public HTTPS origin, without a path such as `/proctor`. |
| `ADMIN_DISPLAY_NAME` | Optional proctor display name. |
| `EXAM_ACCESS_CODE` | Optional fallback registration code. The exam settings can supply a different code. |
| `PROCTOR_PIN` | Optional additional proctor sign-in field. |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Optional credentials and model override for proctor-initiated analysis. |
| `MAX_EVIDENCE_PER_SESSION` | Maximum retained JPEGs per attempt, including the reference image. Defaults to 15, with a minimum of 7. |

Render Free services sleep after 15 minutes without inbound traffic. Open the application before the exam and wait for it to respond. PostgreSQL keeps exam data and evidence across app restarts. [Render Free limits](https://render.com/docs/free)

## Monitoring and student data

Camera frames and microphone samples are processed in the browser. The server receives a reference photo, selected event images, observation metadata, and submitted answers. Raw microphone audio stays on the student device. Evidence, answer keys, reports, and exports are restricted to proctors. If a proctor requests Gemini analysis, the configured provider receives a report summary or the question and written response, depending on the action.

Review flags alongside the available evidence and exam context. Lighting, background speech, and device conditions can affect observations. Share the monitoring and data-retention arrangements with students before the exam.

Voice activity detection uses the bundled [libfvad WebAssembly port](https://github.com/Ozymandiasthegreat/libfvad-wasm). Its license and notices are in [`app/static/vendor/libfvad/`](app/static/vendor/libfvad/).

## Testing and exam readiness

The repository’s recorded in-process test completed **250 attempts** with temporary SQLite storage. Hosted capacity depends on the Render instance, PostgreSQL, the network, and the volume of evidence uploads.

```sh
python -m pip install pytest
python -m pytest -q
node --test tests/channels.test.cjs
python load_test_250.py --in-process --students 250
```

For a 150-student exam, rehearse against a dedicated staging deployment and staging database. Run the command below with staging `ADMIN_USERNAME` and `ADMIN_PASSWORD` set in your shell. If staging uses an access code or proctor PIN, set `EXAM_ACCESS_CODE` or `PROCTOR_PIN` in the shell as well. Replace the example URL with your staging URL.

```sh
python load_test_250.py --base-url https://your-staging-service.onrender.com --students 150
```

The hosted test creates accounts, attempts, and evidence in the target database. Verify completed submissions and exported results, then run a separate browser rehearsal on representative devices to check camera, microphone, and fullscreen behavior.

## Technology

Python, FastAPI, and Uvicorn serve the application. The browser client uses JavaScript, MediaPipe Tasks Vision, and libfvad WebAssembly. SQLite supports local runs, and PostgreSQL provides persistent storage for hosted deployments.
Made by Naman and Jayesh😊
