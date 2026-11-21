# Correo de autenticación: hoy (servicio de Supabase) y mañana (Resend con dominio propio)

## 1. Hoy: servicio de correo predeterminado de Supabase (Staging)

BusinessAI todavía no tiene dominio propio. Staging envía los correos de Auth (confirmación de registro,
recuperación de contraseña) con el **servicio predeterminado de Supabase**, que:

- solo entrega a buzones de **miembros de la organización de Supabase** (cualquier otra dirección se rechaza);
- permite **unos 2 correos por hora** para todo el proyecto (respuesta `429 over_email_send_rate_limit`).

No se desactiva la confirmación de correo ni se reduce ninguna protección para probar.

### Configuración que hace el propietario (una vez)

**Supabase → proyecto `businessai-staging` → Authentication → URL Configuration**

| Campo | Valor |
|---|---|
| Site URL | `https://businessai-git-claude-businessai-platform-52cd8d-ortiiz0037-lab.vercel.app` |
| Redirect URLs | `https://businessai-git-claude-businessai-platform-52cd8d-ortiiz0037-lab.vercel.app/**` |
| Redirect URLs (opcional, desarrollo local) | `http://localhost:3000/**` |

Procedencia: variable `STAGING_URL` del repositorio, alias de la Preview que publica Vercel en el PR #1 y endpoint
del webhook de Stripe TEST. La app construye sus enlaces con `NEXT_PUBLIC_APP_URL`, que en Vercel Preview es esa
misma URL (`scripts/staging/vercel-env.mjs`).

**Plantillas** (Authentication → Email Templates), recomendadas para que el enlace funcione aunque se abra en
otro navegador o en el iPhone:

- Confirm signup: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=signup&next=/onboarding`
- Reset password: `{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/reset-password`

(La plantilla por defecto `{{ .ConfirmationURL }}` también funciona, pero solo en el mismo navegador donde se pidió.)

**GitHub → repositorio → Settings → Secrets and variables → Actions → New repository secret**

| Secreto | Valor |
|---|---|
| `STAGING_AUTH_TEST_EMAIL` | El correo de un **miembro de la organización de Supabase** cuyo buzón alguien pueda abrir. Nunca `@example.com`. Es secreto porque los registros de este repositorio son públicos; las pruebas nunca lo imprimen. |

### Pruebas

| Etiqueta en el PR #1 | Qué hace | Correos enviados |
|---|---|---|
| `staging:test` (paso 5) | Configuración de Auth, destino de los enlaces, confirmación con enlace, recuperación en otro navegador, enlace falsificado, cuenta sin confirmar sin acceso. Enlaces generados con la API de administración | **0** |
| `staging:auth-email` | **Correos reales**: registro desde el formulario → correo de confirmación → una persona pulsa el enlace; «olvidé mi contraseña» → correo → la persona pulsa el enlace, escribe una contraseña nueva y guarda. Comprueba en Supabase cada paso (confirmación registrada; inicio de sesión tras el correo; la contraseña antigua deja de servir) | **2** |

`staging:auth-email` **no envía nada** si: hubo un correo de Auth en los últimos 60 minutos, los enlaces de
Supabase no vuelven a la Preview, o el buzón ya pertenece a una cuenta real de Staging. Espera hasta 15 minutos por
cada correo; cuando el registro de la ejecución diga `ACTION:`, abre el correo en el buzón autorizado y pulsa el
enlace. La cuenta de prueba se borra al final.

## 2. Mañana: Resend con dominio propio (Staging y Production)

La app ya usa Resend para los recordatorios de cobro (`src/lib/email/resend.ts`: `RESEND_API_KEY`, `EMAIL_FROM`;
sin ellas no se envía nada ni se marca nada como enviado).

1. **Dominio**: comprarlo y verificarlo en Resend (Resend → Domains → Add domain → registros DNS que muestra Resend
   en el proveedor del dominio).
2. **Supabase → Authentication → SMTP Settings** (cada proyecto: Staging y, con su autorización, Production):
   activar Custom SMTP con los datos que muestra Resend en su sección SMTP — host, puerto, usuario — y como
   contraseña una **API key de Resend** (pegarla solo en Supabase). Remitente: `no-reply@<dominio>`, nombre
   `BusinessAI`. Después, **Authentication → Rate Limits**: subir los correos por hora.
3. **Vercel → Environment Variables** (Preview para Staging; Production por separado): `RESEND_API_KEY` (sensible) y
   `EMAIL_FROM` (`BusinessAI <no-reply@<dominio>>`) para los correos que envía la propia app.
4. **Production**: Site URL y Redirect URLs del dominio propio; `NEXT_PUBLIC_APP_URL=https://<dominio>` en Vercel
   Production (obligatoria: sin ella la app no envía enlaces de recuperación); mismas plantillas que en §1.
5. **Pruebas**: con SMTP propio desaparece la restricción a miembros y el límite de 2 por hora. `staging:auth-email`
   sigue igual (`STAGING_AUTH_TEST_EMAIL` puede ser cualquier buzón de pruebas que alguien lea); no hace falta
   cambiar código.

Ningún paso de §2 se ha ejecutado.

### Staging: SMTP de Resend preparado (pendiente de DNS y clave)

Motivo: en el plan gratuito de Supabase, con el servicio de correo por defecto, la API rechaza cambiar las
plantillas (*"Email template modification is not available for free tier projects using the default email
provider"*). Con SMTP propio, las plantillas con `token_hash` funcionan en cualquier navegador o dispositivo.

| Paso | Quién | Qué |
|---|---|---|
| 1 | Propietario | Resend → Domains → Add domain `mail.mybusinessai.site` (región us-east-1) |
| 2 | Propietario | Spaceship → DNS de `mybusinessai.site`: los 3 registros que muestra Resend (DKIM `resend._domainkey.mail`, MX y TXT SPF `send.mail`); ningún registro existente cambia |
| 3 | Propietario | Resend → API Keys → *Sending access*, dominio `mail.mybusinessai.site` → secreto de GitHub `STAGING_RESEND_SMTP_KEY` |
| 4 | Etiqueta `staging:auth-smtp-plan` | Solo lectura: DNS publicados + SMTP actual/objetivo de Staging |
| 5 | Etiqueta `staging:auth-smtp-apply` | Solo los campos `smtp_*` de Staging (`smtp.resend.com:465`, usuario `resend`, remitente `BusinessAI (Staging) <no-reply@mail.mybusinessai.site>`) |
| 6 | Etiqueta `staging:auth-templates-apply` | Solo el enlace de las plantillas Confirm signup y Reset password → `token_hash` |
| 7 | `staging:test` (0 correos) y, con aprobación, 1 correo de recuperación abierto en el teléfono | Verificación entre dispositivos |

