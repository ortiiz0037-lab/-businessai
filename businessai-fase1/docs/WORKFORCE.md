# Personal / Workforce — diseño, seguridad y reglas

Migraciones **0020** (empleados, reloj, correcciones, ausencias, turnos,
historial) y **0021** (modo PIN para tabletas, evidencia solo-anexar).
Ambas son **borradores con `STAGING-GATE`: no aplicadas en ningún entorno.**

## Quién ve y hace qué (lo aplica PostgreSQL con RLS y funciones)

| Persona | Cómo entra | Ve | Puede |
|---|---|---|---|
| Propietario / administrador (`workforce.manage`) | Su cuenta de la empresa | Todo el personal de la empresa, tarifas | Empleados, departamentos, supervisores, reglas, tabletas, PIN, ponchar por otros, aprobar |
| Supervisor (miembro asignado a un departamento) | Su cuenta de la empresa | Solo los empleados de **sus** departamentos (lista, ponches, turnos, ausencias, historial, panel en vivo, informes y CSV) | Ponchar por ellos (quiosco), programar turnos, pedir y aprobar correcciones y ausencias — **nunca las suyas** |
| Empleado (cuenta vinculada) | `/clock` con su propia cuenta | Solo su ficha, sus ponches, turnos y solicitudes | Ponchar, pedir correcciones y ausencias, crear su PIN |
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
la futura nómina), ni reglas por empleado.

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

## Decisiones pendientes

| Tema | Hoy | Decidir |
|---|---|---|
| Turnos nocturnos | Cuentan el día en que empiezan | Confirmar para nómina |
