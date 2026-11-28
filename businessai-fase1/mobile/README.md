# BusinessAI · iOS, iPadOS y Android (esqueleto de la fase 1)

Esqueleto **sin dependencias instaladas** para los contenedores nativos descritos en
`docs/MOBILE.md`. Nada aquí se ejecuta en el build web ni en las pruebas.

## Qué hay

- `capacitor.config.json`: plantilla del contenedor Capacitor que **carga la app web
  de producción** (`server.url`). El dominio se completa cuando el propietario lo
  autorice; solo HTTPS, navegación limitada al dominio de la app
  (`limitsNavigationsToAppBoundDomains` en iOS), sin depuración en Android.

## Cuando se autorice la fase 1 (pasos)

1. `npm i -D @capacitor/cli && npm i @capacitor/core @capacitor/ios @capacitor/android` (en
   un paquete propio dentro de `mobile/`, para no tocar las dependencias de la web).
2. `npx cap add ios && npx cap add android` y completar `server.url`.
3. Plugin de voz que implemente el **puente v1** (`window.BusinessAINative`, contrato en
   `docs/MOBILE.md` §3 y tipos en `src/lib/voice/engines.ts`): iOS `SFSpeechRecognizer`
   (`requiresOnDeviceRecognition` cuando el idioma lo permita) + `AVSpeechSynthesizer`;
   Android `SpeechRecognizer` (`EXTRA_PREFER_OFFLINE`) + `TextToSpeech`. Solo texto
   cruza el puente.
4. Textos de permisos: `NSMicrophoneUsageDescription`, `NSSpeechRecognitionUsageDescription`,
   `NSCameraUsageDescription` (iOS); `RECORD_AUDIO`, `CAMERA` (Android).
5. Enlaces universales / App Links para `/auth/*`, `/invite/*`, `/clock/link/*`.
6. Iconos PNG (1024 px) y pantalla de inicio a partir de `public/icon.svg`.
7. Pruebas de humo en simuladores (inicio de sesión, asistente con voz, adjunto de gasto,
   editor de Document Studio con la barra de formato en iPhone y iPad).

## Document Studio en móvil (S5)

El editor ya está preparado para el contenedor: pestañas Editar / Vista previa en
teléfonos, barra de formato fija arriba con botones de 40 px, tablas con controles por
fila y columna que se desplazan dentro de su caja, y comparación de versiones que cabe
en la pantalla (probado en iPhone 13 e iPad Mini).
