$key = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdrYnFsdHp0YWR1a2Zia25ucXFkIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3OTg2MzIxNiwiZXhwIjoyMDk1NDM5MjE2fQ.2jR-_queWBfWTOwyn-med74JxSgqatXaB0U_9CqI85Q"

# Use Supabase Management API to run SQL
$sql = "SELECT conname, pg_get_constraintdef(oid) as def FROM pg_constraint WHERE conrelid = 'public.tests'::regclass AND contype = 'c'"
$body = [System.Text.Encoding]::UTF8.GetBytes("{`"query`":`"$sql`"}")

# Try via postgres endpoint
$r = Invoke-WebRequest -Uri "https://gkbqltztadukfbknnqqd.supabase.co/pg/query" -Method POST -ContentType "application/json" -Headers @{"apikey"=$key;"Authorization"="Bearer $key"} -Body $body -ErrorAction SilentlyContinue
Write-Host "pg/query Status: $($r.StatusCode)"
Write-Host $r.Content

# Also try inserting with known term values to find what works
$token = "eyJhbGciOiJFUzI1NiIsImtpZCI6IjFlYzdiMjA5LTFmZmItNDQ4NS05YmZhLTkzYTQxYWI0NjIxOCIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJodHRwczovL2drYnFsdHp0YWR1a2Zia25ucXFkLnN1cGFiYXNlLmNvL2F1dGgvdjEiLCJzdWIiOiI0ZDQ2MjI4OS03MWY2LTRhMTUtYWIzOS01MmE3MmE3NDExODQiLCJhdWQiOiJhdXRoZW50aWNhdGVkIiwiZXhwIjoxNzgwMTM0NzM4LCJpYXQiOjE3ODAxMzExMzgsImVtYWlsIjoidGVhY2hlckBlZHV2by5jb20iLCJwaG9uZSI6IiIsImFwcF9tZXRhZGF0YSI6eyJwcm92aWRlciI6ImVtYWlsIiwicHJvdmlkZXJzIjpbImVtYWlsIl19LCJ1c2VyX21ldGFkYXRhIjp7ImVtYWlsX3ZlcmlmaWVkIjp0cnVlfSwicm9sZSI6ImF1dGhlbnRpY2F0ZWQiLCJhYWwiOiJhYWwxIiwiYW1yIjpbeyJtZXRob2QiOiJwYXNzd29yZCIsInRpbWVzdGFtcCI6MTc4MDEzMTEzOH1dLCJzZXNzaW9uX2lkIjoiMzY1MGJmNWUtZTlmNC00MGEzLWJmMWMtNmI2MjRlODNlYzJhIiwiaXNfYW5vbnltb3VzIjpmYWxzZX0.8BpYqHbAuxmEQWOLgP9moChIJ2eHxijbdyIFcHzy6UPSMFLDkjoqkBx24YCTCQ3wV9x1TZ2YeTpbL9nDS9YzYg"

foreach ($termVal in @("Term 1", "term1", "1", "T1", "first")) {
    $testBody = [System.Text.Encoding]::UTF8.GetBytes("{`"title`":`"Debug Test`",`"subject`":`"Maths`",`"class_name`":`"Class 10`",`"section`":`"A`",`"term`":`"$termVal`",`"date`":`"2025-12-19`",`"questions`":[{`"type`":`"mcq`",`"text`":`"test`",`"marks`":1,`"options`":[{`"text`":`"A`"},{`"text`":`"B`"},{`"text`":`"C`"},{`"text`":`"D`"}],`"correct_option`":0}]}")
    $r2 = Invoke-WebRequest -Uri "https://eduvo-production.up.railway.app/api/tests" -Method POST -ContentType "application/json" -Headers @{"Authorization"="Bearer $token"} -Body $testBody -ErrorAction SilentlyContinue
    Write-Host "term='$termVal' -> Status:$($r2.StatusCode) Body:$($r2.Content)"
}
