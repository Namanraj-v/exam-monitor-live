@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" goto setup
".venv\Scripts\python.exe" -c "import fastapi,pydantic,uvicorn,psycopg,psycopg_pool,httpx,dotenv" >nul 2>&1
if not errorlevel 1 goto run
:setup
call SETUP.bat
if errorlevel 1 goto failed
:run
if not exist ".env" copy /y ".env.example" ".env" >nul
".venv\Scripts\python.exe" launch_local.py
if not errorlevel 1 exit /b 0
:failed
echo Startup failed. See the error above.
pause
exit /b 1
