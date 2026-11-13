# Intelligence Engine (Entrega 10)

Núcleo de inteligencia de BusinessAI, independiente del proveedor, sobre el que funciona el Asistente
(docs/ASSISTANT.md). Esta entrega corrige los hallazgos A1–A13 de la auditoría (Entregas 9 y 9.1) e
implementa el contrato neutral, el adaptador de Anthropic con streaming, el registro de modelos, el router,
la verificación estructurada de cifras, la medición de costos y la autorización de servidor sin service role.

**No se ha llamado a ningún proveedor real ni se ha configurado ninguna clave real.** Todo se probó contra un
doble local del Messages API (`e2e/local-stack/llm-double.mjs`). La migración 0030 es un borrador local.

## 1. Componentes

| Archivo | Responsabilidad |
|---|---|
| `src/lib/intelligence/types.ts` | Contrato neutral: mensajes y partes (texto, llamada y resultado de herramienta, parte opaca del proveedor), uso por categoría, motivos de parada, `LlmProvider`, `ProviderError` (con `retriable`). |
| `src/lib/intelligence/adapters/anthropic.ts` | Adaptador Anthropic con el SDK oficial: streaming (`messages.stream`), cancelación (`AbortSignal`), timeout por llamada, réplica exacta del contenido del proveedor dentro del turno (bloques de razonamiento), mapeo de motivos de parada y de errores. |
| `src/lib/intelligence/registry.ts` | Registro de modelos verificados (id, contexto, salida, capacidades, precios por categoría, retirada, fuente y fecha). |
| `src/lib/intelligence/router.ts` | Router con reglas explícitas, niveles P0–P3, modelos aprobados por nivel, cadena de respaldo sin bajar de nivel. |
| `src/lib/intelligence/cost.ts` | Costo exacto en nano-dólares (enteros) por categoría de tokens; precio de contexto largo. |
| `src/lib/intelligence/facts.ts` | Cifras verificables: resultados tipados, referencias `[[Tn.ruta]]`, renderizado en el servidor, verificador, `calculate`, respuesta de respaldo con solo datos verificados. |
| `src/lib/intelligence/server-auth.ts` | Firma HMAC de las escrituras internas (mensajes canónicos idénticos a 0030), rotación de claves. |
| `src/lib/assistant/engine.ts` | Bucle del turno: herramientas, verificación con una regeneración, respaldo, escalado, plazo, cancelación; devuelve uso y costo en cualquier resultado. |
| `src/lib/assistant/tools.ts` | 15 herramientas tipadas (incluida `calculate`), permisos en una consulta (`assistant_access`), totales completos en SQL. |
| `src/lib/assistant/service.ts` | Sesión del usuario, turno firmado (inicio y fin), acciones con ejecución reanudable. |
| `src/app/api/assistant/stream/route.ts` | Turno por Server-Sent Events, mismo origen, cuerpo ≤ 16 KB, `maxDuration = 60`. |
| `supabase/migrations/0030_intelligence_core.sql` | Autorización de servidor, turnos, presupuestos, acciones con arrendamiento, agregados, acceso. Rollback: `supabase/rollback/0030_rollback.sql`. |

## 2. Flujo de una solicitud

```
Navegador ──POST /api/assistant/stream (mismo origen)──▶ streamTurn (sesión del usuario: auth.uid(), RLS)
  1. assistant_begin_turn  [firma HMAC: usuario + empresa + conversación + nonce + hora + texto]
       → cuota (usuario/día, empresa/día, ráfagas, presupuesto en USD, tokens) atómica, conversación, mensaje del usuario
  2. assistant_access (1 consulta) → herramientas permitidas;  classify + route → modelo y respaldos
  3. runTurn: adaptador (streaming) ⇄ herramientas (RLS) → resultados tipados T1, T2…
       texto provisional → navegador (event: delta);  progreso de herramientas (event: tool)
       final: verificar cifras → renderizar en el servidor  (1 regeneración; si no, solo datos verificados)
  4. assistant_finish_turn [firma HMAC sobre el payload exacto]
       → respuesta, proveedor, modelo, nivel, ruta, tokens por categoría, costo, latencia, verificación, auditoría
  5. event: final (conversación verificada)
Cancelación (Detener / desconexión) o fallo del proveedor → el paso 4 se ejecuta igual con el uso consumido.
```

## 3. Autorización de servidor (sin service role)

- Las lecturas y las operaciones de negocio siguen con el **JWT del usuario** (RLS, `has_permission`). El
  asistente no importa ni usa `src/lib/supabase/admin.ts` (comprobado por una prueba de arquitectura en
  `tests/assistant-boundaries.test.ts`).
- Las escrituras internas (inicio y fin de turno, ejecución de acciones) llevan además una firma
  HMAC-SHA256 con una clave que solo conocen el servidor (`ASSISTANT_SERVER_KEYS`) y la base de datos
  (`ba_private.assistant_server_keys`, ilegible para usuarios). La base de datos verifica:
  - `auth.uid()` del JWT forma parte del mensaje firmado (una firma no sirve para otro usuario);
  - hora ±120 s y nonce de un solo uso (sin repetición); fin de turno y ejecución son transiciones de estado únicas;
  - pertenencia y permiso en la empresa (`has_permission`), la conversación es del usuario.
- Si la clave se filtrara, el daño se limita al propio usuario autenticado y a sus empresas (con la service
  role sería toda la base de datos).
- **Rotación**: registrar la clave nueva (`assistant_set_server_key`), ponerla primera en
  `ASSISTANT_SERVER_KEYS`, retirar la anterior con gracia (`assistant_retire_server_key(id, now() + interval '1 hour')`).
- **Cerrado por defecto**: sin clave en el servidor o sin clave registrada, el asistente no arranca y lo dice.
- Revocadas a `authenticated`: `assistant_log`, `assistant_consume`, `assistant_record_usage`,
  `assistant_add_message`, `assistant_propose_action`, `assistant_decide_action`, `assistant_finish_action`.

Configuración (requiere autorización y acceso del propietario; **no realizada**):
```
# servidor (secreto):   ASSISTANT_SERVER_KEYS="k1:<base64 de 32 bytes aleatorios>"
# base de datos (SQL del propietario):  select public.assistant_set_server_key('k1', '<el mismo base64>');
```

## 4. Registro de modelos (verificado el 2026-11-13)

Fuentes: https://platform.claude.com/docs/en/models/overview y https://platform.claude.com/docs/en/about-claude/pricing.

| Modelo | Niveles aprobados (provisional) | $/MTok entrada · salida · escritura caché 5 min · lectura caché |
|---|---|---|
| `claude-haiku-5-5` | P0 | 0.10 · 0.50 · 0.125 · 0.01 (≤ 100K de prompt; 0.50 · 2.50 · 0.625 · 0.05 por encima) |
| `claude-sonnet-5-5` | P0, P1 | 2 · 10 · 2.50 · 0.10 |
| `claude-opus-5-5` | P0–P3 | 4 · 20 · 5 · 0.20 |
| `claude-fable-5-2` | P0–P3 (respaldo de P2/P3) | 8 · 40 · 10 · 0.20 |

OpenAI y Google **no están registrados**: su documentación oficial no fue accesible desde el entorno de
desarrollo. Añadir un proveedor = un adaptador que implemente `LlmProvider` + entradas verificadas en el
registro; el motor, las herramientas y la interfaz no cambian.

## 5. Router

- Niveles: P0 conversación · P1 consulta ligera · P2 precisión (cifras, finanzas, nómina/asistencia,
  cualquier acción, cualquier mensaje en una pantalla financiera) · P3 análisis con datos de negocio.
- Modelo principal por nivel entre los aprobados; `ASSISTANT_MODEL` fija un modelo solo en los niveles para los
  que está aprobado (en los demás se usa el del router y se registra `pin_not_approved_for_Px`).
- Respaldo: ante sobrecarga, límite de tasa, red o timeout, el siguiente de la cadena con **rango igual o
  superior**; nunca uno inferior. Se registra `fallback_from`.
- Escalado: si el modelo pide una herramienta de nivel superior al que tiene aprobado, el turno se reinicia una
  vez con un modelo aprobado (se registra `escalated_from`).
- La aprobación por nivel es una política provisional y conservadora hasta medir los modelos con el benchmark.

## 6. Cifras verificadas

1. Cada herramienta devuelve datos con **tipo declarado por campo** (dinero, conteo, fecha, horas, porcentaje,
   texto) y metadatos (moneda, fecha o período, completitud, fuente). El dinero viaja como decimal exacto
   construido desde centavos enteros.
2. El modelo **cita** cada cifra con `[[T1.ruta]]`; el servidor la renderiza desde el resultado registrado.
3. El verificador rechaza referencias que no resuelven y cualquier dígito escrito por el modelo que no
   provenga de la pregunta del usuario (salvo marcadores de lista y rutas internas).
4. Cifras derivadas: herramienta `calculate` (suma, diferencia, porcentaje de, variación) sobre referencias,
   aritmética entera, sin mezclar monedas.
5. Si falla: una regeneración; si vuelve a fallar, se muestran solo los datos verificados (sin redacción).
6. Límite reconocido: el verificador garantiza el origen de cada cifra, no que el modelo elija la métrica o el
   período adecuados para la pregunta; eso lo medirá el benchmark.

## 7. Costos y presupuestos

- Costo por llamada = tokens por categoría × precio del registro (nano-dólares); `cost_status`: `estimated`
  (precio verificado), `test` (doble local), `unpriced`, `none`.
- Presupuesto mensual por empresa y plan (`assistant_limits.company_monthly_budget_nanos`): basic USD 5, pro
  USD 25, premium USD 100. **Valores PROVISIONALES**: no son precios ni límites comerciales aprobados; se
  configuran en la tabla y deben decidirse comercialmente antes de activar el asistente. Alertas de auditoría al 50 %, 80 % y 100 %. Al superarlo, el
  asistente se detiene para la empresa hasta el mes siguiente.
- Ráfaga por usuario (6/min) y por empresa (20/min); límites diarios de 0029; el límite de tokens cuenta solo
  tokens sin caché.

## 8. Streaming, plazos y cancelación

- `maxDuration = 60` en la ruta; plazo del turno `ASSISTANT_TURN_DEADLINE_MS` (10–55 s, por defecto 50 s);
  timeout por llamada = tiempo restante; 1 reintento del SDK por llamada.
- El texto que llega en streaming se muestra como **borrador provisional** (marcadores como «…»); al terminar se
  reemplaza por la respuesta verificada.
- **Detener** cancela la llamada al proveedor; el turno queda registrado como `cancelled` con su uso.
- Límite real pendiente de verificar: la duración máxima de funciones en el plan de Vercel del proyecto.

## 9. Pruebas

Ver los resultados en el informe de la entrega. Suites: SQL `98_intelligence.test.sql`, concurrencia
`99_intelligence_race.sh`, arnés (escenario 36), unitarias `tests/assistant.test.ts` y
`tests/assistant-boundaries.test.ts`, E2E `e2e/assistant.auth.e2e.mjs` con el doble en streaming.

## 10. Centro de inteligencia (0031, `/assistant/insights`)

Panel para propietario y administrador (`assistant.audit`) con el uso del asistente en la empresa: solicitudes
por resultado, nivel y usuario; por modelo, tokens (entrada, salida, caché), costo, latencia media y p95,
respaldos y escalados; costo del período y del mes frente al presupuesto del plan; verificación de cifras;
herramientas usadas o denegadas; instrucciones sospechosas, límites, errores del proveedor y alertas de
presupuesto. Calculado en SQL sobre todos los turnos del período (`assistant_insights`, máximo un año, días
de Puerto Rico). **Solo metadatos**: nunca el texto ni el título de las conversaciones. Los miembros no lo ven.

Los turnos atendidos por el doble de pruebas local registran costo 0 (`cost_status = test`): no son gasto
real y no consumen el presupuesto.

## 11. Benchmark y aprobación de modelos (Entrega 11)

El benchmark reproducible (datos ficticios, doble local, evaluador con fallos
críticos, compuerta, regresiones) está en `bench/` y se documenta en
[`docs/BENCHMARK.md`](BENCHMARK.md). El enrutador admite
`ASSISTANT_ROUTER_POLICY=benchmark`, que usa solo aprobaciones humanas de
corridas **reales** (`src/lib/intelligence/approvals.json`, vacío); la
política de producción sigue siendo la provisional. Nueva herramienta
`get_bank_overview` (0032, `bank.view`; saldo en libros solo con
`accounting.view`) y canario por turno contra fugas del prompt.
