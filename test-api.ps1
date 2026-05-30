$loginBody = [System.Text.Encoding]::UTF8.GetBytes('{"email":"teacher@eduvo.com","password":"Test@1234"}')
$loginResp = Invoke-WebRequest -Uri "https://eduvo-production.up.railway.app/api/auth/login" -Method POST -ContentType "application/json" -Body $loginBody -ErrorAction SilentlyContinue
Write-Host "Login Status: $($loginResp.StatusCode)"
Write-Host $loginResp.Content

$loginData = $loginResp.Content | ConvertFrom-Json
$token = $loginData.data.token
Write-Host "Token: $($token.Substring(0,40))..."

$testBody = [System.Text.Encoding]::UTF8.GetBytes('{"title":"Debug Test","subject":"Maths","class_name":"Class 10","section":"A","term":"term 1","date":"2025-12-19","questions":[{"type":"mcq","text":"who is whom","marks":1,"options":[{"text":"A"},{"text":"B"},{"text":"C"},{"text":"D"}],"correct_option":0}]}')

$testResp = Invoke-WebRequest -Uri "https://eduvo-production.up.railway.app/api/tests" -Method POST -ContentType "application/json" -Headers @{"Authorization"="Bearer $token"} -Body $testBody -ErrorAction SilentlyContinue
Write-Host "Test Status: $($testResp.StatusCode)"
Write-Host $testResp.Content
