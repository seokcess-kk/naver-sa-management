# Scripts

## 첫 admin 승격

새 사용자는 `lib/auth/access.ts`에서 viewer로 자동 생성됩니다.
첫 admin 승격은 Supabase SQL Editor에서 직접 처리:

1. `/login` 회원가입 → 로그인 (UserProfile 자동 생성)
2. Supabase Dashboard → Authentication → Users 탭에서 본인 user.id (UUID) 복사
3. `promote-admin.sql` 내 `{USER_ID}`를 본인 UUID로 치환
4. Supabase Dashboard → SQL Editor에 붙여넣기 → Run

성공 시 두 번째 SELECT가 `role = admin` 인 row 1개를 반환합니다.

이후 사용자 추가 / 권한 변경은 `/admin/users` UI 사용 (admin 권한 보유 사용자가).

## Cron 수동 호출

로컬 dev에서 Cron 동작 확인 (Authorization 헤더에 CRON_SECRET):

```bash
# Linux/Mac
CRON_SECRET=$(grep CRON_SECRET .env.local | cut -d= -f2)
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/stat-daily
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/stat-hourly
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/auto-bidding
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/alerts
curl -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/stat-cleanup
```

```powershell
# Windows PowerShell
$secret = (Get-Content .env.local | Select-String "^CRON_SECRET=").ToString().Split("=")[1]
curl.exe -H "Authorization: Bearer $secret" http://localhost:3000/api/cron/stat-daily
```
