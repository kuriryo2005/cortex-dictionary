@echo off
cd /d "%~dp0"

echo.
echo ============================================================
echo  Cortex Dictionary  本番復旧
echo ============================================================
echo.
echo  この画面でやること:
echo    1. Vercel にログイン（ブラウザが開きます）
echo    2. 手元で「実際に生成できた」キーだけを本番に入れ直す
echo    3. 再デプロイして、生成できるようになったか確認する
echo.
echo  キーの値は画面に出しません（末尾4文字だけ照合用に出ます）。
echo.
pause

echo.
echo ---- 1/3  Vercel にログイン ----------------------------------
call npx vercel whoami >nul 2>&1
if errorlevel 1 (
  echo ブラウザが開きます。ログインしたらこの画面に戻ってください。
  call npx vercel login
  if errorlevel 1 goto failed
) else (
  echo すでにログイン済みです。
)

echo.
echo ---- 2/3  キーを本番に入れ直して再デプロイ --------------------
call node scripts/push-keys-to-vercel.mjs
if errorlevel 1 goto failed

echo.
echo ---- 3/3  本番の状態を確認 ------------------------------------
echo 反映まで少し待ちます...
timeout /t 45 /nobreak >nul
call curl -s -A "Mozilla/5.0" https://lexi-log-puce.vercel.app/api/health
echo.
echo.
echo  canGenerate:true  なら復旧しています。
echo  keys の total が増えているかも見てください。
echo.
echo  まだ false の場合は、この画面をそのままクロードに見せてください。
echo.
pause
exit /b 0

:failed
echo.
echo ============================================================
echo  途中で失敗しました。この画面をそのままクロードに見せてください。
echo ============================================================
echo.
pause
exit /b 1
