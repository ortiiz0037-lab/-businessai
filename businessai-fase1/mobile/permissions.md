# Permisos nativos (textos para Info.plist y AndroidManifest)

Solo los que usa una función existente; ninguno se pide al abrir la app, sino al usar la función.

| Permiso | Para qué (texto mostrado al usuario) | Función |
|---|---|---|
| iOS `NSCameraUsageDescription` / Android `CAMERA` | «BusinessAI usa la cámara para leer códigos de barras y fotografiar recibos.» | Escáner de inventario y punto de venta (S7/S8), recibos (S6) |
| iOS `NSMicrophoneUsageDescription` / Android `RECORD_AUDIO` | «BusinessAI usa el micrófono solo mientras hablas con el asistente.» | Voz del asistente (S4) |
| iOS `NSSpeechRecognitionUsageDescription` | «El reconocimiento de voz convierte tu pregunta en texto en el dispositivo.» | Voz del asistente |
| iOS `NSPhotoLibraryUsageDescription` | «Para adjuntar una foto existente de un recibo o el logo de tu empresa.» | Recibos, logo |
| Notificaciones (iOS / Android 13+ `POST_NOTIFICATIONS`) | «Avisos de aprobaciones, pagos y cierres de caja.» | Fase 2: no implementado |

No se piden ubicación, contactos ni Bluetooth: los lectores de código Bluetooth funcionan en modo
teclado (HID), sin permiso de la app.
