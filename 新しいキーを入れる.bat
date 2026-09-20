@echo off
cd /d "%~dp0"

echo.
echo ============================================================
echo  新しい Gemini API キーを反映する
echo ============================================================
echo.
echo  1. メモ帳が開きます
echo  2. AI Studio で作った新しいキーを、1行に1つ貼り付けて保存して閉じる
echo  3. あとは自動（生死確認 → 本番投入 → 再デプロイ → 確認）
echo.
echo  2～6番の枠はそのまま残します。
echo.
pause

call node scripts/apply-new-keys.mjs
if errorlevel 1 goto failed

echo.
call node scripts/push-keys-to-vercel.mjs
if errorlevel 1 goto failed

echo.
echo ---- 本番の状態 ----------------------------------------------
timeout /t 40 /nobreak >nul
call curl -s -A "Mozilla/5.0" https://lexi-log-puce.vercel.app/api/health
echo.
echo.
pause
exit /b 0

:failed
echo.
echo 途中で失敗しました。この画面をそのままクロードに見せてください。
echo.
pause
exit /b 1
