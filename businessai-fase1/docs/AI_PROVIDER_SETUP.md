# Proveedor de IA real (Anthropic): configuración segura y prueba

**Estado:** el asistente está implementado contra la API real de Anthropic (SDK
oficial), pero **todavía no se ha llamado al proveedor real**: no hay clave
configurada en ningún entorno y no se ha generado gasto. Este documento es el
procedimiento para hacerlo cuando el propietario lo autorice.

> **Reglas de oro.** La clave nunca se escribe en el código, en un commit, en un
> issue, en un chat ni en un registro. Nunca va en una variable `NEXT_PUBLIC_*`.
> Solo la leen el servidor y el script de prueba. Si se expone, se revoca de
> inmediato (§7).

## 1. Antes de empezar (decisiones del propietario)

1. **Autorización escrita** para crear una cuenta de pago en Anthropic y para la
   prueba real (costo de la prueba: una fracción de centavo).
2. **Entorno**: primero **Staging** (Vercel Preview + Supabase Staging). Production
   solo después de una prueba correcta en Staging y con otra autorización.
3. **Límite de gasto** en la consola de Anthropic (Workspace de BusinessAI): poner
   un tope mensual bajo al principio. BusinessAI aplica además sus propios límites
   por plan (`assistant_limits`, alertas 50/80/100 %).

## 2. Crear la clave

1. En la consola de Anthropic, crear un **Workspace** «BusinessAI Staging» (y otro
   para Production más adelante): las claves, el gasto y los límites quedan separados.
2. Crear una **API key** en ese workspace. Copiarla **directamente** al gestor de
   secretos del paso 3 (no a un documento ni a un mensaje).

## 3. Guardar la clave en el servidor

| Dónde | Cómo |
|---|---|
| **Vercel (Staging / Preview)** | Project → Settings → Environment Variables → `ANTHROPIC_API_KEY`, tipo *Sensitive*, solo en el entorno *Preview* (o el de Staging). Nunca *Development* compartido. Volver a desplegar la Preview para que la tome. |
| **Sesión de desarrollo en la nube (Claude Code)** | Usar el formulario de credenciales del entorno (secreto de red para `api.anthropic.com`): el proxy inyecta la cabecera y el valor nunca llega al chat ni a los registros. En el proceso basta un valor ficticio en `ANTHROPIC_API_KEY`. |
| **Máquina local** | Archivo `.env.smoke.local` (ignorado por git: `.gitignore` excluye `.env*`), permisos `600`, cargado solo para el comando de prueba. |

Variables relacionadas (todas **solo servidor**): `ASSISTANT_MODEL` (opcional, un
modelo registrado), `ASSISTANT_ROUTER`, `ASSISTANT_ROUTER_POLICY`,
`ASSISTANT_TURN_DEADLINE_MS`, `ASSISTANT_DISABLED=1` (apagado de emergencia).
`ANTHROPIC_BASE_URL` no se define en Staging ni en Production.

## 4. Clave de firma del servidor (obligatoria)

El asistente no arranca sin una clave de firma registrada (0030: las escrituras
internas van firmadas). Es **otro** secreto, generado por nosotros:

1. Generar 32 bytes aleatorios en una máquina de confianza: `openssl rand -base64 32`.
2. Guardar en Vercel `ASSISTANT_SERVER_KEYS=stg1:<base64>` (Sensitive, Preview).
3. Registrar **la misma** clave en la base de datos de Staging, como propietario de
   la base de datos (editor SQL de Supabase, no desde la app):
   `select public.assistant_set_server_key('stg1', '<base64>');`
   El editor SQL guarda historial: borrar la consulta después o usar una sesión
   `psql` sin historial. Ningún usuario de la app puede registrar claves.

## 5. Prueba real mínima (una llamada)

Con autorización del propietario y la clave cargada **solo** en el entorno del comando:

```bash
set -a; . ./.env.smoke.local; set +a          # contiene ANTHROPIC_API_KEY (no se imprime)
ASSISTANT_SMOKE_ALLOW_PAID=1 node scripts/assistant/smoke-real.mjs
# opcional: --model claude-sonnet-5-5   (por defecto claude-haiku-5-5, el más barato)
```

Salida esperada (sin la clave, sin ningún fragmento de ella):

```json
{ "ok": true, "real_provider": true, "host": "api.anthropic.com", "model_requested": "claude-haiku-5-5",
  "model_served": "claude-haiku-5-5", "stop_reason": "end_turn", "reply": "OK",
  "usage": { "input_tokens": 30, "output_tokens": 2 }, "latency_ms": 900, "request_id": "req_…" }
```

Errores posibles: `auth` (clave inválida o revocada), `permission`, `rate_limit`,
`model_not_found`, `overloaded_or_server`, `network`, `timeout`. El script sale con
código 2 y **no llama a nadie** si falta `ASSISTANT_SMOKE_ALLOW_PAID=1` o la clave.
Sin costo, el mismo script se comprueba contra el doble local:
`node scripts/assistant/smoke-real.mjs --double http://127.0.0.1:<puerto> --key <clave del doble>`.

## 6. Prueba en la aplicación y benchmark real

1. En la Preview de Staging, con la clave y la firma configuradas: abrir el
   asistente, preguntar «¿Qué facturas están vencidas?» y comprobar «Cifras
   verificadas», el modelo y el costo del turno en `/assistant/insights`.
2. Benchmark real (opcional, autorizado aparte; cuesta más):
   `BENCH_ALLOW_PAID=1 ANTHROPIC_API_KEY=… node bench/run.mjs --provider anthropic`.
   Solo un informe **real** con la puerta superada permite aprobar modelos por nivel
   (`src/lib/intelligence/approvals.json`, revisión humana).

## 7. Rotación, revocación e incidentes

- **Rotación** (cada 90 días o al cambiar el equipo): crear clave nueva → actualizar
  Vercel → redesplegar → comprobar con §5 → revocar la anterior en la consola.
- **Clave de firma**: añadir `stg2:<base64>` como primera entrada de
  `ASSISTANT_SERVER_KEYS` y registrarla; retirar la vieja con
  `assistant_retire_server_key('stg1')` cuando no queden turnos abiertos.
- **Si una clave se expone** (commit, captura, chat): revocarla en la consola **de
  inmediato**, crear otra, revisar el uso del workspace y, si estaba en git, limpiar
  el historial con el propietario del repositorio.
- **Apagado de emergencia**: `ASSISTANT_DISABLED=1` en Vercel y redesplegar.

## 8. Lo que el código garantiza (probado)

- La clave solo se lee en el servidor (`src/lib/assistant/config.ts`); las pruebas
  `tests/assistant-boundaries.test.ts` comprueban que no hay `NEXT_PUBLIC_` de
  secretos ni rol de servicio.
- `publicAssistantState` nunca devuelve la clave ni la URL al navegador.
- Errores del proveedor → códigos cortos; el texto del error del proveedor no se
  muestra al usuario ni se guarda con la clave.
- Sin clave o sin firma registrada, el asistente **no responde** y lo dice: no hay
  respuestas simuladas fuera de las pruebas locales.
