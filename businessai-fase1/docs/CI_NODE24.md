# GitHub Actions · aviso de Node 20 → Node 24 (revisión de compatibilidad)

**Estado: solo propuesta. Ningún workflow se ha modificado.** Requiere la aprobación del propietario.

## El aviso

En cada ejecución (CI, `e2e-auth.yml`): *"Node.js 20 is deprecated. The following actions target Node.js 20 but are
being forced to run on Node.js 24: actions/checkout@v4, actions/setup-node@v4."* Hoy no rompe nada: GitHub ya ejecuta
esas acciones con Node 24 y todos los runs están en verde (CI #92, E2E #4 en `b48246f`). Es un aviso de obsolescencia.

**No confundir:** `node-version: 22` (la versión de Node con la que se compila y prueba la app) no cambia. El aviso
trata del runtime interno de las acciones.

## Inventario (5 workflows)

| Acción | Versión actual | Dónde |
|---|---|---|
| `actions/checkout` | v4 | ci, e2e-auth, staging, staging-test, staging-demo |
| `actions/setup-node` | v4 (`cache: npm` explícito, `cache-dependency-path`) | los mismos 5 |
| `actions/upload-artifact` | v4 | staging-test (capturas de la Preview) |

Los 5 usan runners alojados por GitHub (`runs-on: ubuntu-24.04`), que siempre tienen el runner actual:
el mínimo v2.327.1 que exigen las versiones nuevas se cumple. No hay runners propios.

## Revisión (notas oficiales de cada acción, páginas de releases de GitHub)

| Acción | Versión mínima con Node 24 | Cambios que nos afectan |
|---|---|---|
| `checkout` | **v5.0.0** (runtime node24, runner ≥ 2.327.1) | Ninguno listado como incompatible. v6 guarda credenciales en un archivo aparte (`$RUNNER_TEMP`) y v7 bloquea por defecto PR de forks en `pull_request_target` / `workflow_run` (no usamos esos eventos) y pasa a ESM. |
| `setup-node` | **v5.0.0** (node24, runner ≥ 2.327.1) | v5 activa caché automática **solo** si `package.json` tiene `packageManager`; el nuestro no lo tiene y ya pasamos `cache: npm` explícito → mismo comportamiento. v6 limita la caché automática a npm; v6.1 quita `always-auth` (no lo usamos); v7 pasa a ESM y quita un `NODE_AUTH_TOKEN` ficticio (no publicamos paquetes). |
| `upload-artifact` | **v6.0.0** (v5 seguía en Node 20 por defecto) | v6 no lista otro cambio. Los archivos ocultos ya se excluyen por defecto desde v4.4.0 (no cambia nada; las capturas no son ocultas). v7 falla si el patrón resuelve varios archivos sin comprimir (`archive: false`); no lo usamos. |

Verificado: las notas no indican el runtime de v6/v7 de `checkout` / `setup-node` ni de `upload-artifact` v7;
las versiones propuestas son las primeras que lo declaran explícitamente.

## Propuesta mínima (solo workflows, sin tocar la app)

```
actions/checkout@v4        → actions/checkout@v5        (5 archivos)
actions/setup-node@v4      → actions/setup-node@v5      (5 archivos; mismas entradas)
actions/upload-artifact@v4 → actions/upload-artifact@v6 (staging-test.yml)
```

11 líneas, ninguna otra entrada cambia. Se eligen las primeras versiones mayores que declaran Node 24 (menos
cambios de comportamiento que v6 / v7); subir a las últimas es un paso aparte.

**Riesgo:** bajo. Lo único que cambia en la práctica es el runtime de las acciones, que GitHub ya fuerza hoy.

**Cómo validarlo sin tocar Staging:** el cambio en `ci.yml` y `e2e-auth.yml` se prueba con un push al PR (los dos se
ejecutan en `pull_request`). Los tres `staging*.yml` solo se ejecutan con una etiqueta `staging:*` o a mano: su
cambio es idéntico, pero **no se ejecutará** hasta la próxima ejecución autorizada de Staging. Opción conservadora:
actualizar primero `ci.yml` + `e2e-auth.yml`, y los de Staging cuando se autorice esa ejecución.

## Fuentes

- https://github.com/actions/checkout/releases
- https://github.com/actions/setup-node/releases
- https://github.com/actions/upload-artifact/releases
