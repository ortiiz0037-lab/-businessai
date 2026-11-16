# BusinessAI en iOS, iPadOS y Android — arquitectura y preparación

**Estado:** preparación. No hay proyectos nativos todavía, no se ha publicado nada
en App Store ni en Google Play y no hay cuentas de desarrollador configuradas. Este
documento fija las decisiones para que el desarrollo web siga sin bloquearse y la
app móvil se construya sobre lo mismo.

## 1. Decisión: un solo producto, una sola lógica

| Opción | Decisión | Por qué |
|---|---|---|
| **Contenedor nativo (Capacitor) que carga la app web** | **Elegida para la fase 1** | Reutiliza el 100 % de la lógica, la seguridad (RLS, funciones de la base de datos, firmas del asistente) y las pruebas. Cada mejora web llega al móvil sin reescribir. Acceso nativo por plugins: voz, notificaciones, cámara, biometría. |
| React Native / Expo con API propia | Fase posterior, solo si hace falta | Requiere duplicar pantallas y exponer una API versionada. Se evalúa si una función necesita UI nativa (p. ej. ponche sin conexión). |
| Solo PWA | Disponible hoy (paso 0) | Instalable en la pantalla de inicio. iOS limita notificaciones y voz; no basta como producto. |

**Regla:** la app móvil no tiene datos ni reglas propias. Lee y escribe con la
sesión del usuario a través de la misma aplicación y las mismas funciones de la
base de datos. Nunca incluye claves de servicio, de Stripe ni del proveedor de IA.

## 2. Hecho en esta entrega (S4)

- **Manifiesto web** (`src/app/manifest.ts`, ruta pública `/manifest.webmanifest`):
  nombre, `standalone`, inicio en `/dashboard`, colores del tema, icono
  (`public/icon.svg`). Metadatos de Apple (`appleWebApp`) en `src/app/layout.tsx`.
- **Pantallas completas**: `viewportFit: 'cover'` y márgenes `safe-area-inset-*` en
  la barra superior, el menú inferior, el menú lateral y el botón del asistente.
- **Voz independiente del dispositivo** (`src/lib/voice/engines.ts`): el asistente
  usa un motor de voz neutral. Si el contenedor móvil inyecta
  `window.BusinessAINative` (versión 1), se usa el reconocimiento nativo; si no, el
  del navegador. Solo **texto** cruza el puente, nunca audio. Probado en
  `tests/voice.test.ts`.
- **Pruebas en tamaños móviles**: todas las pruebas de navegador comprueban que no
  haya desplazamiento horizontal en iPhone 13 (y iPad Mini en Finanzas).

- **Esqueleto de la fase 1** (`mobile/`): plantilla `capacitor.config.json` (solo HTTPS,
  navegación limitada al dominio de la app) y los pasos de creación; sin dependencias
  instaladas.
- **Inventario en móvil (S7)**: escáner con la cámara del iPhone / iPad (ZXing en Safari,
  `BarcodeDetector` donde exista) y con lectores Bluetooth en modo teclado emparejados con el
  dispositivo; recepción, conteos y transferencias escaneando; probado en iPhone 13 e iPad Mini
  (sin cámara física en las pruebas). En la app nativa se podrá usar el escáner nativo
  (AVFoundation / ML Kit) a través del mismo contrato de «código leído».
- **Recibos con la cámara (S6)**: `/bank/receipts` abre la cámara trasera del iPhone / iPad
  (`capture="environment"`), reduce las fotos grandes a JPEG y las sube a almacenamiento
  privado; probado en iPhone 13 e iPad Mini. Plaid Link en el contenedor nativo
  necesitará el SDK de Plaid o la redirección OAuth (fase 1).
- **Document Studio en móvil (S5)**: barra de formato fija con botones táctiles, tablas
  con desplazamiento propio y comparación de versiones probadas en iPhone 13 e iPad Mini.

## 3. Contrato del puente nativo (versión 1)

```ts
window.BusinessAINative = {
  version: 1,
  speech: { start({ lang, maxMs }, cb), stop(), abort() },   // cb({ type: 'partial'|'final'|'error'|'end', text?, code? })
  tts:    { speak(text, lang), stop() },
}
```

- Solo *pulsar para hablar*: sin palabra de activación ni escucha continua, con
  corte duro a los 30 s (igual que en la web).
- iOS: `SFSpeechRecognizer` con `requiresOnDeviceRecognition` cuando el idioma lo
  permita; `AVSpeechSynthesizer` para leer respuestas.
- Android: `SpeechRecognizer` (preferir `EXTRA_PREFER_OFFLINE`); `TextToSpeech`.
- Un objeto con otra versión se ignora (no se confía en globales extraños).

## 4. Sesión y enlaces

- La sesión de Supabase vive en cookies HTTP del dominio. El WebView (WKWebView /
  Android WebView) las conserva; no se copian tokens a JavaScript nativo.
- **Universal Links (iOS) / App Links (Android)** para `/auth/*`, `/invite/*` y
  `/clock/link/*`: restablecer contraseña, invitaciones y vinculación de empleados
  abren la app. Requiere publicar `apple-app-site-association` y `assetlinks.json`
  en el dominio de producción (pendiente; lo decide el propietario).
- El asistente usa `POST /api/assistant/stream` (streaming) con la misma cookie:
  funciona dentro del WebView sin cambios.

## 5. Notificaciones (fase 2)

APNs (iOS) y FCM (Android) para: facturas vencidas, gastos por aprobar,
solicitudes de personal y recordatorios del CRM. Diseño: tabla de dispositivos por
usuario y empresa (token cifrado, plataforma, idioma), envío desde el servidor con
las mismas reglas de permisos que la pantalla correspondiente, sin cifras en la
notificación (solo «tienes 3 facturas vencidas» → abre la pantalla). Necesita una
migración nueva y cuentas de Apple y Google: **no implementado**.

## 6. iPad

- Diseño adaptable ya probado (iPad Mini). En iPad se aprovecha la barra lateral
  de escritorio (`md:`); Split View y Slide Over funcionan con el mismo diseño.
- Teclado físico: los formularios ya envían con Enter; el asistente también.

## 7. Requisitos de las tiendas (lista de control)

| Requisito | Estado |
|---|---|
| Textos de permisos: micrófono (`NSMicrophoneUsageDescription`), reconocimiento de voz (`NSSpeechRecognitionUsageDescription`), cámara para adjuntos; Android `RECORD_AUDIO`, `CAMERA` | Por redactar al crear los proyectos nativos |
| Iconos PNG (1024 × 1024 sin transparencia para iOS; adaptativos para Android) y pantallas de inicio | **Pendiente** (hoy solo hay SVG) |
| Eliminación de la cuenta desde la app (App Store 5.1.1(v)) | **Pendiente**: no existe aún un flujo de eliminación de cuenta de usuario |
| Etiquetas de privacidad / Data safety (datos financieros, de contacto, audio no almacenado) | Por completar con el inventario de datos |
| Contenido generado por IA: el asistente lo indica, cita sus fuentes y no actúa sin confirmación | Hecho |
| Suscripciones: hoy se pagan con Stripe en la web. Apple puede exigir compra dentro de la app (3.1.1) o permitir el modelo de cuenta empresarial | **Decisión del propietario** antes de publicar |

## 8. Plan de fases

1. **Fase 0 (hoy):** PWA instalable, voz con puente, pantallas seguras en móvil.
2. **Fase 1:** proyectos Capacitor (iOS, Android) que cargan el dominio de
   producción; plugins de voz, cámara (adjuntos de gastos, logotipo) y biometría
   para reabrir la sesión; enlaces universales; iconos; TestFlight / pruebas internas.
3. **Fase 2:** notificaciones push; ponche de empleados con ubicación opcional y
   cola sin conexión **solo para ponches** (se envían al reconectar, con la hora del
   dispositivo marcada y revisión del supervisor). Nada financiero se escribe sin conexión.
4. **Fase 3:** widgets (resumen del día), atajos de Siri / acciones de Android que
   abren el asistente con una pregunta prellenada (nunca ejecutan acciones solas).

## 9. Pruebas

- Hoy: Playwright con perfiles de iPhone 13 y iPad Mini en cada prueba de navegador.
- Fase 1: pruebas de humo en simuladores (XCUITest / Espresso) del inicio de sesión,
  el asistente con voz (puente simulado) y la subida de un adjunto.
