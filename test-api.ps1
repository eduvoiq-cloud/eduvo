# test-api.ps1 — Local API smoke test
# Runs against localhost:3001 ONLY. Never edit this to point at production.
# Usage: .\test-api.ps1
# Pre-requisite: backend server must be running (npm run dev in backend-api/)

$BASE = "http://localhost:3001"

Write-Host "`n=== Staff Login ===" -ForegroundColor Cyan
$loginBody = '{"email":"teacher@school.com","password":"YourLocalPassword"}'
try {
  $loginResp = Invoke-RestMethod -Uri "$BASE/api/auth/login/staff" -Method POST `
    -ContentType "application/json" -Body $loginBody
  $token = $loginResp.data.token
  Write-Host "Login OK — token: $($token.Substring(0, 20))..." -ForegroundColor Green
} catch {
  Write-Host "Login failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}

Write-Host "`n=== GET /api/auth/me ===" -ForegroundColor Cyan
try {
  $me = Invoke-RestMethod -Uri "$BASE/api/auth/me" -Method GET `
    -Headers @{ Authorization = "Bearer $token" }
  Write-Host "Role: $($me.data.user.role) | School: $($me.data.user.school_id)" -ForegroundColor Green
} catch {
  Write-Host "GET /me failed: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "`n=== GET /api/schools/list (public) ===" -ForegroundColor Cyan
try {
  $schools = Invoke-RestMethod -Uri "$BASE/api/schools/list" -Method GET
  Write-Host "Schools returned: $($schools.data.Count)" -ForegroundColor Green
} catch {
  Write-Host "GET /schools/list failed: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "`n=== Health check ===" -ForegroundColor Cyan
try {
  $health = Invoke-RestMethod -Uri "$BASE/health" -Method GET
  Write-Host "Status: $($health.status)" -ForegroundColor Green
} catch {
  Write-Host "Health check failed: $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "`nDone." -ForegroundColor Cyan
