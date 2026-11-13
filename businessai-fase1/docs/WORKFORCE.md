# Personal / Workforce — diseño, seguridad y reglas

Migraciones **0020** (empleados, reloj, correcciones, ausencias, turnos,
historial), **0021** (modo PIN para tabletas, evidencia solo-anexar), **0022**
(grupos de reglas, jurisdicciones, alertas de comida) y **0033** (RR. HH.:
estado laboral, documentos privados, turnos recurrentes, cambios de turno,
excepciones y versiones de reglas). Todas son **borradores con
`STAGING-GATE`: no aplicadas en ningún entorno.**

## Quién ve y hace qué (lo aplica PostgreSQL con RLS y funciones)

| Persona | Cómo entra | Ve | Puede |
|---|---|---|---|
| Propietario / administrador (`workforce.manage`) | Su cuenta de la empresa | Todo el personal de la empresa, tarifas | Empleados, departamentos, supervisores, reglas, tabletas, PIN, ponchar por otros, aprobar |
| Supervisor (miembro asignado a un departamento, o **supervisor directo** del empleado, 0033) | Su cuenta de la empresa | Solo los empleados de **sus** departamentos o **sus reportes directos** (lista, ponches, turnos, ausencias, historial, panel en vivo, informes y CSV). **No** ve documentos laborales privados ni el contacto privado | Ponchar por ellos (quiosco), programar turnos y patrones, pedir y aprobar correcciones, ausencias y cambios de turno, registrar la acción tomada en alertas — **nunca las suyas** |
| Empleado (cuenta vinculada) | `/clock` con su propia cuenta | Solo su ficha, sus ponches, turnos, solicitudes, **sus alertas**, los documentos que la empresa **le compartió** y su contacto de emergencia | Ponchar, pedir correcciones, ausencias y cambios de turno, crear su PIN, actualizar su contacto de emergencia |
| Empleado en tableta | `/kiosk` con número + PIN | Su nombre, el ponche y la hora — nada más | Ponchar |
| Miembro sin rol de personal | — | Nada del módulo | — |

* Suspender a un supervisor o quitarlo del departamento le retira el acceso
  al instante (probado). Las tarifas solo las ve quien tiene `workforce.manage`.
* Los empleados **no ocupan usuarios del plan**. Límite de empleados
  **activos**: Básico 3, Pro 25, Premium 100; el reloj está incluido desde
  Básico. El límite se cumple también con altas o reactivaciones
  simultáneas (pruebas de concurrencia para los tres planes).

## Reloj y evidencia

* La hora de cada ponche la pone el servidor (`clock_timestamp()`); el
  teléfono o la tableta no pueden elegirla.
* Secuencia obligatoria `entrada → (descanso → regreso)* → salida`, bajo un
  bloqueo por empleado: dos toques simultáneos producen un solo ponche.
* Los ponches pasados solo entran por **correcciones** (añadir, anular,
  cambiar) con motivo, quién pidió, quién decidió y cuándo. Una corrección que
  dejaría la secuencia inválida se rechaza.
* **Nadie aprueba su propia asistencia** (tampoco un supervisor que también
  es empleado). Un supervisor puede aplicar una corrección que él mismo pidió
  **para otra persona**; queda marcado `self_requested` en el historial.
* **Solo-anexar (0021), también para la clave de servidor y el editor SQL:**
  el historial (`workforce_events`) no se modifica ni se borra; un ponche no
  se borra ni cambia de hora — solo se anula una vez; una solicitud decidida
  no cambia (una ausencia aprobada solo puede pasar a cancelada, guardando
  quién la canceló). Solo borrar la empresa completa elimina su evidencia.

## Modo PIN para tabletas compartidas (0021)

1. Un administrador registra la tableta (Personal → Reglas → Tabletas) y abre
   el enlace de activación **en la tableta** una sola vez. Se guarda un token
   de 256 bits en una cookie `httpOnly` (`SameSite=Strict`, ruta `/kiosk`); en
   la base de datos solo su SHA-256.
2. La tableta **no inicia sesión con ninguna cuenta**: si se pierde no expone
   cuentas ni datos; se desactiva con un clic y deja de funcionar al instante.
3. Cada empleado poncha con **número de empleado + PIN de exactamente 6 dígitos** (obligatorio, decisión del propietario). El
   PIN se guarda con sal aleatoria y 5 000 iteraciones de SHA-256 en una tabla
   que ningún rol de la API puede leer. Se rechazan PIN triviales (1234, 0000,
   9876…).
4. Fuerza bruta: 5 PIN incorrectos bloquean ese PIN 15 minutos; 20 fallos en
   10 minutos bloquean la tableta 10 minutos. La respuesta es **la misma** para
   número inexistente, PIN incorrecto o bloqueo: la tableta no permite
   descubrir números de empleado. Los contadores se guardan de verdad (la
   función devuelve un estado en lugar de abortar).
5. Privacidad: la tableta solo recibe nombre de pila, tipo de ponche y hora;
   la confirmación se borra a los 6 segundos. No puede listar ni leer nada.

Límites conocidos: un PIN de 6 dígitos (1 000 000 combinaciones) sigue siendo
corto; el bloqueo lo protege en línea, pero quien acceda directamente a la base
de datos podría probar PIN offline. Un compañero que conozca
el PIN de otro puede ponchar por él (igual que con tarjetas): las correcciones
y el historial quedan como evidencia.

## Cálculo de horas (`src/lib/workforce/hours.ts`)

* El tiempo trabajado de una sesión pertenece al **día local en que empezó**
  (zona horaria de la empresa). Un turno nocturno 22:00–06:00 cuenta una sola
  vez, en el día y la semana en que empezó; no se divide ni se repite.
* Horas extra: primero las **diarias** (más de N horas en el día), después
  las **semanales** sobre las horas regulares restantes (más de M a la
  semana). Nunca se cuentan dos veces: regular + extra = trabajado, siempre.
* Las extras semanales se calculan con **la semana completa**, aunque el
  informe empiece a mitad de semana.
* Las horas son tiempo real transcurrido (correcto en cambios de horario).
* Sesiones de más de 16 horas se marcan “a revisar” (probable salida olvidada).
* Tardanza: entrada después del inicio del turno + tolerancia. Ausencia:
  turno pasado sin ponches y sin permiso aprobado de día completo.

## Reglas predeterminadas de Puerto Rico — **no es asesoría legal**

Los valores iniciales (extras después de 8 horas en un día o 40 en una
semana; multiplicador 1.5) son una **referencia general configurable**.
Pueden no aplicar a una empresa o a todos sus empleados (empleados exentos,
contratados antes de 2017, decretos mandatorios, convenios colectivos, otras
jurisdicciones). BusinessAI calcula con la configuración elegida; **no ofrece
asesoría legal ni garantiza el cumplimiento** de leyes laborales. La pantalla
de reglas y los informes lo indican. Todavía **no** se calculan: periodos de
comida obligatorios, importes de horas extra (el multiplicador se guarda para
la futura nómina). Las reglas por empleado llegaron con 0033 (excepciones).

## Reglas por empleado, jurisdicciones y comidas (0022)

* **Jurisdicciones:** catálogo de plantillas de **referencia** (Puerto Rico,
  EE. UU. federal, California, personalizada). Una plantilla solo copia
  valores a la empresa o a un grupo cuando un administrador la aplica; todo
  sigue siendo editable. Nada se asume: sin plantilla no hay reglas de comida.
* **Grupos de reglas:** cada empleado usa los valores de la empresa o un
  grupo (exentos, convenios, turnos especiales) con sus propias horas extra
  diarias/semanales, multiplicador, exención y reglas de comida. La base de
  datos (`wf_rules`) y los informes usan las mismas reglas.
* **Alertas de comida:** trabajo continuo sin una pausa de al menos la
  duración mínima antes del límite produce “se aproxima” (N minutos antes) e
  “incumplido”. Una pausa corta no cuenta como comida. Se evalúan con cada
  ponche y mientras el panel en vivo está abierto; quedan en un historial que
  no se borra, con quién las atendió. Las ven los supervisores del empleado,
  los administradores y el propio empleado; nadie atiende su propia alerta.
  **Limitación:** sin un programador (Supabase Cron, no configurado) una
  alerta “se aproxima” solo se genera si alguien tiene el panel abierto o hay
  un ponche; no se envían correos (Resend no configurado).

## Recursos humanos (0033)

**Estado laboral.** Activo, **suspendido**, inactivo o baja. Suspender o dar
de baja exige un motivo (queda en el historial). Un suspendido no puede
ponchar y **no cuenta** para el límite del plan; al reactivarlo el servidor
vuelve a comprobar el límite (Básico 3, Pro 25, Premium 100 empleados
activos, también con altas simultáneas). Los empleados nunca ocupan
usuarios del plan. **Archivar** solo se permite a inactivos o dados de baja:
los oculta de las listas sin borrar nada; se puede restaurar.

**Ficha.** Tipo de empleo (tiempo completo, parcial, temporal, de temporada,
contratista, práctica), clasificación (no exento / exento), supervisor
directo (un miembro activo; nunca el propio empleado) y el historial con
**valor anterior → nuevo** de los campos no sensibles (nunca tarifa, notas,
contacto ni acceso). El **contacto privado** (dirección, contacto de
emergencia) vive en su propia tabla: solo administradores y el empleado.

**Documentos laborales privados.** Bucket privado `HR-documents`
(`<empresa>/<empleado>/<archivo>`, PDF o imagen, 10 MB). Solo los
administradores suben, ven y archivan; el empleado ve un documento solo si se
le comparte; los supervisores nunca. Se descargan con un enlace firmado de 60
segundos. No se borran (ni con la clave de servidor): se archivan. La
interfaz pide no subir información médica.

**Sucursales.** El catálogo de planes ya prevé sucursales (Básico 1, Pro 3,
Premium 10), pero el módulo de sucursales no existe todavía: la asignación de
empleados a sucursales queda para cuando exista (no se creó una fuente
paralela).

**Turnos.** Turnos individuales (0020) y **patrones recurrentes** (días de la
semana, hora de inicio y fin; si la hora de fin es menor, termina al día
siguiente). Un patrón **genera** turnos concretos para un periodo (máx. 93
días): no duplica, omite los días con otro turno o con ausencia aprobada de
día completo y dice cuántos omitió. El empleado puede **pedir un cambio o
quitar** un turno futuro; lo decide su supervisor (nunca él mismo); si el
turno cambió después de la solicitud, hay que decidir de nuevo; un cambio que
se cruzaría con otro turno se rechaza y queda pendiente. La regla de no
solaparse ahora se cumple también con escrituras simultáneas (bloqueo por
empleado). **Conflictos**: turnos durante ausencias aprobadas, turnos futuros
de empleados no activos y semanas programadas por encima del límite semanal
de horas extra.

**Turnos nocturnos.** Por defecto cuentan **el día en que empiezan**. La
empresa puede elegir **dividirlos a medianoche** (cada parte cuenta en su día;
los descansos van al día en que ocurrieron; el total es el mismo).

**Reglas.** Precedencia: **excepciones del empleado** → clasificación exenta →
grupo → valores de la empresa. Cualquier cambio de reglas (empresa, grupo o
excepción) se **propone** y solo surte efecto cuando un administrador lo
**aplica explícitamente** (con confirmación). Una propuesta queda obsoleta si
las reglas cambiaron después (se rechaza al aplicarla). Cada cambio, por
cualquier vía, crea una **versión** inmutable con quién, cuándo y los valores.
Las plantillas (Puerto Rico, EE. UU. federal, California, personalizada) se
muestran como propuesta y están marcadas como **vigencia no verificada**:
BusinessAI no ha verificado su vigencia actual; no es asesoría legal ni
garantía de cumplimiento.

**Alertas de comida y descanso.** Al atenderla, el supervisor registra la
**acción tomada** (comida tardía, horario ajustado, se recordó al empleado,
no requiere acción, otra con nota). El empleado ve sus propias alertas. Sin
programador las alertas se evalúan con cada ponche y mientras el panel en vivo
está abierto. **Preparado, no activado:** la función `wf_meal_sweep()` evalúa
todas las sesiones abiertas de todas las empresas; solo la puede ejecutar el
dueño de la base de datos (no la API). Programarla requiere autorización y
acceso al proyecto: ver `supabase/cron/wf_meal_sweep.sql`. No se envían
correos ni notificaciones push.

**Ausencias.** Nuevos tipos: duelo, servicio de jurado, licencia parental y
servicio militar. Calendario mensual de ausencias (aprobadas y pendientes).
No se piden diagnósticos: la interfaz lo advierte.

**Ponches faltantes.** Salidas olvidadas (sesión abierta desde un día anterior)
y turnos que empezaron sin entrada (más la tolerancia, sin ausencia
aprobada). Aparecen en el panel en vivo; se corrigen con una corrección
aprobada.

**Informes.** Añaden ponches corregidos y anulados, y la nota «resumen de
asistencia según las reglas configuradas; no es una nómina oficial ni
asesoría legal». La nómina será una entrega separada.

**Integraciones.** Asistente: `list_employees`, `get_attendance_report` y
`get_workforce_status` (conteos, sin nombres ni tarifas) para administradores
y supervisores (también directos). Document Studio usa la misma tabla de
empleados (certificados y campos `employee.*`). Finanzas: sin cambios hasta
la nómina. Una sola fuente de horas (ponches) y de personas (empleados).

## Decisiones pendientes

| Tema | Hoy | Decidir |
|---|---|---|
| Turnos nocturnos | Configurable: día de inicio (predeterminado) o división a medianoche | Confirmar para nómina |
| Programador de alertas | `wf_meal_sweep()` preparado, no programado | Autorizar Supabase Cron (cada 5 min) |
| Notificaciones | Solo en la app | Proveedor de correo / push |
| Vigencia de plantillas | Marcadas «no verificada» | Revisión por un asesor laboral |
| Sucursales | Módulo inexistente | Entrega de sucursales |
