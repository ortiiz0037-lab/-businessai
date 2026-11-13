# Asistente BusinessAI (Entrega 8)

Asistente central integrado en toda la plataforma: botón flotante en cada pantalla
de la aplicación, centro de conversaciones en `/assistant`, respuestas con datos
reales y autorizados, propuestas de borradores con confirmación explícita, voz
push-to-talk y auditoría. **No hay respuestas simuladas**: sin una clave de
proveedor configurada el asistente lo dice y no responde.

## 0. Cambios de la Entrega 10 (prevalecen sobre el texto de abajo)

- **Núcleo independiente del proveedor** (docs/INTELLIGENCE.md): contrato neutral, adaptador Anthropic con
  streaming, registro de modelos verificado, router con niveles P0–P3 y respaldo que nunca baja de nivel.
- **Escrituras internas firmadas por el servidor** (0030): inicio y fin de turno, uso, costo, auditoría y
  ejecución de acciones requieren una firma HMAC (`ASSISTANT_SERVER_KEYS` + clave registrada en la base de
  datos). Las funciones de 0029 que permitían falsificar auditoría, cuota, uso o historial ya no son
  ejecutables por usuarios. Sin service role. Cerrado por defecto.
- **Cifras verificadas**: el modelo cita cada cifra con `[[Tn.ruta]]` y el servidor la renderiza desde datos
  tipados; cifras escritas por el modelo se rechazan (una regeneración; si no, solo datos verificados).
- **A1 corregido**: el estado de resultados usa `incomeTotals()` (el impuesto sobre la renta es un gasto).
- **Totales completos en SQL** (sin sumas sobre páginas truncadas) y dinero en centavos enteros.
- **Turnos registrados** con proveedor, modelo, nivel, ruta, tokens por categoría, costo y latencia, también
  cuando el proveedor falla o el usuario detiene la respuesta.
- **Acciones idempotentes y reanudables**: confirmación con clave de solicitud, ejecución con arrendamiento
  (máx. 3 intentos), progreso guardado para no duplicar el borrador, botón Reintentar.
- **Presupuesto mensual en USD por plan** con alertas 50/80/100 % y límite de ráfaga por empresa.
- **Streaming** con texto provisional, botón Detener, fuentes con fecha de los datos y modelo usado.
- **Voz**: aviso de privacidad y consentimiento antes del primer uso del micrófono.
- La interfaz usa `POST /api/assistant/stream`; la acción `assistantSend` de la Entrega 8 se retiró.

## 1. Estado y lo que requiere una clave externa

| Pieza | Estado |
|---|---|
| Migración `0029_assistant.sql` + rollback | Borrador local (STAGING-GATE). **No aplicada** en Staging ni en Producción. |
| Integración con el proveedor (SDK oficial `@anthropic-ai/sdk`) | Implementada y probada contra un **doble de prueba local** del Messages API. **No se ha llamado a ningún proveedor real** (no hay clave; no se ha generado gasto). |
| Para activarla de verdad | Definir en el **servidor** `ANTHROPIC_API_KEY` (y, si se desea, `ASSISTANT_MODEL`, `ASSISTANT_EFFORT`). Requiere una cuenta del proveedor con facturación: es un servicio de pago que **no se ha contratado**. Aplicar 0029 en el entorno correspondiente con su aprobación. |

Variables (solo servidor; nunca `NEXT_PUBLIC_*`):

| Variable | Uso |
|---|---|
| `ANTHROPIC_API_KEY` | Obligatoria para activar el asistente. Nunca se registra ni se devuelve al navegador. |
| `ASSISTANT_MODEL` | Opcional. Por defecto `claude-opus-5-5`. |
| `ASSISTANT_EFFORT` | Opcional: `low`, `medium` (defecto), `high`. |
| `ANTHROPIC_BASE_URL` | Opcional. Solo `https`; fuera de producción se acepta `http://127.0.0.1`/`localhost` (doble de pruebas). |
| `ASSISTANT_DISABLED=1` | Apaga el asistente sin quitar la clave. |

## 2. Arquitectura

```
Navegador (widget flotante / centro)          Servidor Next.js (acciones de servidor)                 PostgreSQL (RLS)
───────────────────────────────────────       ─────────────────────────────────────────────          ──────────────────────
AssistantChat ── assistantSend ─────────────▶ service.sendMessage                                     assistant_consume (límites, plan)
  texto / voz (texto final)                     ├─ zod: entrada                                       assistant_start_conversation
  ruta actual (contexto de pantalla)            ├─ límites + conversación propia ─────────────────▶  assistant_add_message
                                                ├─ loadAccess: has_permission ×14, company_feature    has_permission / company_feature
                                                ├─ toolsFor(access): solo herramientas permitidas
                                                ├─ engine.runTurn (bucle manual)
                                                │    provider.complete ──▶ LlmProvider (SDK oficial)
                                                │    tool_use → zod → tool.run(sesión del usuario) ─▶ tablas y funciones de cada módulo (RLS)
                                                │    tool_result envuelto como <untrusted_data>
                                                ├─ assistant_record_usage / assistant_log ──────────▶ assistant_usage / assistant_events
                                                └─ respuesta (texto, rastro de herramientas, acciones)
ActionCard ── assistantDecide ──────────────▶ service.decideAction ─────────────────────────────▶  assistant_decide_action (una vez)
                                                └─ createAssistantDraft (Document Studio) ───────▶  studio_save_document (origin=assistant)
                                                                                                       assistant_finish_action
```

Archivos:

| Archivo | Responsabilidad |
|---|---|
| `src/lib/assistant/config.ts` | Lectura de la configuración del servidor; estado público sin clave ni URL. |
| `src/lib/assistant/provider.ts` | Capa de proveedor independiente (`LlmProvider`); implementación con el SDK oficial; errores tipados → códigos cortos. |
| `src/lib/assistant/tools.ts` | Registro de herramientas: esquemas zod → JSON Schema estricto, permisos y plan por herramienta, límites de filas, datos mínimos. |
| `src/lib/assistant/engine.ts` | Bucle manual: `end_turn`, `tool_use`, `pause_turn`, `max_tokens`, `refusal`, `model_context_window_exceeded`; límites de pasos y llamadas. |
| `src/lib/assistant/prompt.ts` | Prompt del sistema, contexto de pantalla, envoltura de datos no confiables, detección de inyección, saneado de la respuesta. |
| `src/lib/assistant/service.ts` | Orquestación con la sesión del usuario: límites, conversaciones, auditoría, acciones confirmadas. |
| `src/lib/studio/draft.ts` | Creación de borradores de Document Studio compartida (formulario de Studio y acciones del asistente: **sin lógica duplicada**). |
| `src/app/actions/assistant.ts` | Acciones de servidor (envoltorios finos). |
| `src/components/assistant/*` | Widget flotante, chat, centro de conversaciones, voz. |
| `supabase/migrations/0029_assistant.sql` | Conversaciones, mensajes, acciones, consumo, límites por plan, auditoría. |

**No se duplican datos ni lógica de negocio**: las herramientas leen las mismas tablas y funciones
que las pantallas (`ar_invoice_balances`, `budget_vs_actual`, `fs_income_statement`, `fs_balance_sheet`,
`buildReport` de asistencia…). La única escritura de negocio (un borrador de Document Studio) pasa por
`studio_save_document`, que vuelve a comprobar permisos y referencias.

## 3. Niveles de acción

| Nivel | Qué hace el asistente | Ejemplo |
|---|---|---|
| Consultar | Lee con herramientas, con los permisos del usuario. | «¿Qué facturas están vencidas?» |
| Recomendar | Explica y aconseja; etiqueta las recomendaciones. | «¿Qué debería cobrar primero?» |
| Preparar borrador | **Propone** (`propose_studio_draft`): se guarda como acción `proposed`; nada se crea hasta que el usuario pulsa **Confirmar**. | «Prepare una carta de cobro» |
| Ejecutar acción | No lo hace. `prepare_operation` devuelve el enlace a la pantalla donde el usuario completa y confirma. | «Registre un pago» |
| Emitir o enviar | No lo hace. Igual que el anterior (emitir factura, emitir documento de Studio). | «Envíe la factura» |

Confirmación (`assistant_decide_action`): solo el autor, una sola vez (fila bloqueada; una segunda
confirmación, otra persona o una propuesta caducada —30 min— se rechazan), con auditoría de cada paso.

## 4. Herramientas

| Herramienta | Permiso / plan | Fuente |
|---|---|---|
| `get_business_overview` | cualquiera de: receivables.view, documents.view, payments.view, payables.view, accounting.view (secciones sin permiso → `not_authorized`) | `ar_invoice_balances`, `documents`, `payments`, `bills`, `fs_balance_sheet` |
| `list_invoices` | receivables.view | `ar_invoice_balances` |
| `list_payments` | payments.view | `payments` (sin anulados) |
| `list_bills` | payables.view | `bills`, `vendors` |
| `get_budget_status` | accounting.view | `budgets`, `budget_vs_actual` |
| `search_clients`, `get_client` | clients.view (+ receivables.view / documents.view para saldos y documentos) | `clients`, `ar_invoice_balances`, `documents` |
| `list_documents` | documents.view | `documents` |
| `list_employees` | plan `employees` + gestionar o supervisar personal | `employees` (sin tarifas ni datos de pago) |
| `get_attendance_report` | plan `time_clock` + gestionar o supervisar | `buildReport` (reglas de la empresa) |
| `get_income_statement` | accounting.view | `fs_income_statement` |
| `list_studio_documents` | studio.view | `studio_documents` |
| `propose_studio_draft` | studio.edit | `assistant_propose_action` → tras confirmar, `studio_save_document` |
| `prepare_operation` | el permiso de la operación | solo devuelve un enlace |

Cada herramienta: se ofrece al modelo solo si el usuario puede usarla; se vuelve a comprobar al
ejecutarse (aunque el modelo la nombre); valida la entrada con zod (`strict`, sin campos extra: el
modelo **no puede** indicar empresa ni usuario); corre con la sesión del usuario (RLS); limita filas
(≤ 50) y devuelve los datos mínimos; sus errores se devuelven como códigos cortos (sin SQL ni trazas).

## 5. Seguridad

- **Aislamiento**: la empresa sale de la sesión; las herramientas no aceptan `company_id`; RLS en todas las
  tablas; conversaciones privadas del autor (ni el propietario las lee); `assistant.audit` ve la auditoría
  (qué herramientas, cuándo, resultado) **sin el texto**.
- **Sin SQL arbitrario ni secretos**: no hay herramienta de SQL; no se usa la clave de servicio; la clave del
  proveedor solo existe en el servidor y la E2E comprueba que no aparece en ningún paquete del navegador.
- **Inyección de instrucciones**: los resultados de herramientas van dentro de `<untrusted_data>` (el contenido
  no puede cerrar el delimitador); el texto que parece instrucciones se marca, se audita (`flagged`) y se avisa
  al modelo de que no lo siga; las acciones requieren confirmación humana en la interfaz (el modelo no puede
  confirmar); la respuesta se muestra como texto (sin HTML) y solo se enlazan rutas internas.
- **Abuso**: límites por plan (`assistant_limits`: consultas por usuario y empresa al día, tokens al mes) y
  ráfaga por minuto, contados de forma atómica; como máximo 8 llamadas al modelo y 12 herramientas por turno;
  4000 caracteres por mensaje; denegación por defecto sin suscripción activa.
- **Auditoría** (`assistant_events`, solo anexar): turnos, herramientas usadas o denegadas, límites, errores del
  proveedor, rechazos, contenido marcado, propuestas, confirmaciones, ejecuciones.

| Plan | Consultas/usuario/día | Consultas/empresa/día | Tokens/empresa/mes | Por minuto |
|---|---|---|---|---|
| basic | 30 | 100 | 2 000 000 | 6 |
| pro | 100 | 400 | 8 000 000 | 6 |
| premium | 300 | 1 500 | 30 000 000 | 6 |

## 6. Experiencia

- Botón flotante en todas las pantallas (`(app)/layout.tsx`); en iPhone, hoja a pantalla completa por encima
  de la barra inferior; en iPad y escritorio, panel en la esquina. Escape cierra.
- Centro `/assistant`: lista de conversaciones, renombrar, archivar / restaurar (nunca borrar), conversación
  completa con su rastro de datos consultados y acciones.
- Contexto de pantalla: la ruta actual (solo ruta interna) se envía y el prompt indica la pantalla y, si la hay,
  el registro abierto; el modelo debe consultarlo con una herramienta (que vuelve a comprobar permisos).
- Español e inglés (interfaz y respuestas).

## 7. Voz

- **Push-to-talk**: mantener pulsado el micrófono, o tocar para empezar y tocar para parar.
  `continuous = false`, parada forzada a los 30 s, el micrófono se libera al cerrar el panel.
  **Sin escucha continua ni palabra de activación.**
- El texto dictado se coloca en la caja y **no se envía solo**: el usuario lo revisa y pulsa Enviar.
- Selección de idioma (es-PR / en-US). Lectura en voz alta de las respuestas (desactivada por defecto).
- Se usa la Web Speech API del navegador: BusinessAI no recibe audio. Algunos navegadores (Chrome, Edge,
  Safari) envían el audio a su propio servicio de reconocimiento; si no está disponible, el botón no aparece.

## 8. Pruebas

| Prueba | Resultado |
|---|---|
| SQL `supabase/tests/local/96_assistant.test.sql` (plan y permisos, privacidad, solo anexar, confirmación única, caducidad, auditoría sin texto, límites, aislamiento, cascada) | 63 aserciones, 0 fallos |
| Concurrencia `97_assistant_race.sh` (doble confirmación simultánea, cuota en carrera) | 2/2 |
| Arnés de migraciones completo, con el escenario 35 (aplica/reaplica, cascada, verify_0014a, rollback con huella idéntica a 0028, rollback se niega con datos) | 413 pasan, 0 fallan |
| Unitarias `tests/assistant.test.ts` (configuración, esquemas estrictos, permisos por rol y plan, validación, inyección, bucle y razones de parada) | 26/26 (suite completa: 608 pasan) |
| E2E autenticada `e2e/assistant.auth.e2e.mjs` (sin clave; con el doble de pruebas: datos reales, contexto, permisos, propuesta → confirmación → borrador único, cancelación, repetición rechazada, inyección, aislamiento, límites, archivo, inglés, voz, iPhone/iPad, clave fuera del navegador) | 70/70 (tres ejecuciones consecutivas en verde) |

El **doble de pruebas** (`e2e/local-stack/llm-double.mjs`) es un servidor local que imita el formato del
Messages API con decisiones guionizadas. No es un modelo y no forma parte del producto: la aplicación solo lo
alcanza si una prueba fija `ANTHROPIC_BASE_URL` a `127.0.0.1`, lo que el código rechaza en producción.

Regresión de entregas anteriores en la misma rama: E2E pública 139/0 (incluye `/assistant`), Finanzas 85/0,
Document Studio 51/0, auditoría visual de Studio 76/0 (3 no comprobables, igual que antes), lint sin errores,
TypeScript sin errores, build de producción correcta.

Ejecución local:

```
npm run build && PSQL=… bash e2e/local-stack/db.sh
PGRST_BIN=… PG_SOCKET=… PG_PORT=… npm run test:e2e:assistant
```

Corrección encontrada por esta E2E: el gráfico de ingresos del panel formateaba las etiquetas del eje con
`Intl` compacto en el servidor y en el navegador, que dan textos distintos (aviso de hidratación #418 en la
consola). Ahora esas etiquetas se dibujan después de hidratar (`src/components/dashboard/revenue-chart.tsx`).

## 9. Limitaciones conocidas (actualizadas en la Entrega 10)

- No se ha probado con el proveedor real (requiere clave y facturación: no autorizado). La calidad de las
  respuestas reales y la aprobación de modelos por nivel no están medidas (benchmark pendiente).
- OpenAI y Google no están integrados: su documentación oficial no fue accesible desde el entorno.
- Activarlo requiere: aplicar 0029 y 0030, configurar `ANTHROPIC_API_KEY` y `ASSISTANT_SERVER_KEYS` en el
  servidor y registrar la clave en la base de datos (pasos del propietario, no realizados).
- La duración máxima real de funciones del plan de Vercel no está verificada (la ruta declara 60 s).
- Si el proceso del servidor muere a mitad de un turno, el uso de ese turno no se registra (el turno queda
  `abandoned` a los 10 minutos); con fallos del proveedor o cancelación sí se registra.
- El verificador garantiza el origen de cada cifra, no que la métrica o el período elegidos sean los adecuados.
- La única acción ejecutable sigue siendo el borrador de Document Studio.
