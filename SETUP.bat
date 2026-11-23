@echo off
setlocal
cd /d "%~dp0"
if exist ".venv\Scripts\python.exe" goto install
for %%V in (3.11 3.12 3.13) do (
  py -%%V -c "import sys" >nul 2>&1
  if not errorlevel 1 (
    py -%%V -m venv .venv
    goto install
  )
)
python -c "import sys; sys.exit(not ((3,11) <= sys.version_info[:2] <= (3,13)))" >nul 2>&1
if not errorlevel 1 (
  python -m venv .venv
  goto install
)
if exist "%USERPROFILE%\anaconda3\python.exe" (
  "%USERPROFILE%\anaconda3\python.exe" -c "import sys; sys.exit(not ((3,11) <= sys.version_info[:2] <= (3,13)))" >nul 2>&1
  if not errorlevel 1 (
    "%USERPROFILE%\anaconda3\python.exe" -m venv .venv
    goto install
  )
)
echo Install Python 3.11, 3.12 or 3.13 with the Windows Python launcher, then run START.bat again.
exit /b 1
:install
if not exist ".venv\Scripts\python.exe" exit /b 1
".venv\Scripts\python.exe" -m pip --version >nul 2>&1
if errorlevel 1 (
  ".venv\Scripts\python.exe" -m ensurepip --upgrade
  if errorlevel 1 exit /b 1
)
".venv\Scripts\python.exe" -m pip install -r requirements.txt pytest
exit /b %errorlevel%
