@echo off
chcp 65001 >nul
cd /d %~dp0
if "%GEMINI_API_KEY%"=="" (
  echo.
  echo Chưa có GEMINI_API_KEY trong phiên Windows này.
  set /p GEMINI_API_KEY=Dan Gemini API key vao day rồi nhấn Enter: 
)
echo.
echo Dang khoi dong Mimi tai http://localhost:3000
npm start
pause
