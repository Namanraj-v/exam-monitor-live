@echo off
cd /d "%~dp0"
.venv\Scripts\python load_test_250.py --in-process --students 250
