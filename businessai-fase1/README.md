# BusinessAI — Fase 1 (auth + multi-tenant + dashboard)

Requisitos: Node >= 20.9 y npm. Un proyecto Supabase (el plan Free sirve).

1. `npm install` (genera `package-lock.json`; consérvalo en git)
2. En Supabase → SQL Editor: ejecuta `supabase/migrations/0001_multitenant_core.sql`
3. Supabase → Authentication → URL Configuration: Site URL `http://localhost:3000`
   Email templates → Confirm signup: enlace `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=email`
   (o desactiva la confirmación por email mientras desarrollas)
4. `cp .env.example .env.local` y rellena las variables
5. `npm run dev` → http://localhost:3000
6. `npm run build`, `npm run lint`, `npm test`

`npm test` corre siempre las pruebas de validadores. Las pruebas de aislamiento (RLS) se omiten
si no hay credenciales; para ejecutarlas usa un proyecto de DESARROLLO y define
`SUPABASE_SERVICE_ROLE_KEY` en `.env.local` (crean y borran usuarios de prueba).
