# Pi Common Harness

Paquete local de Pi con extensiones separadas y configuración de proyecto.

## Estructura

```text
extensions/
  pi-anim/          Animación senoidal durante el trabajo del agente
  provider-gate/    Aprobación humana antes de cada request al provider
  provider-wire-debug/ Proxy HTTP opt-in para inspeccionar el body real
  protected-paths/  Hook previo a herramientas y política de paths
  theme-map/        Perfiles de tema configurables por proyecto
.pi/
  protected-paths.yaml
tests/
```

## Instalación

```bash
npm install
pi install -l .
```

También se pueden probar directamente:

```bash
pi \
  --extension ./extensions/pi-anim/index.ts \
  --extension ./extensions/protected-paths/index.ts
```

## Animación

`pi-anim` monta el widget mientras el agente está activo, anima una señal senoidal con ruido binario y lo desmonta al finalizar. El mensaje del loader queda configurado como `PHANTOM SIGNAL // MODEL PROCESSING`.

## Paths protegidos

La ubicación predeterminada es `.pi/protected-paths.yaml`:

```yaml
protectedPaths:
  - .env
  - secrets/
  - config/production.yaml
```

Los paths relativos se resuelven desde el directorio de trabajo de Pi. Una barra final declara un directorio incluso si todavía no existe. También se aceptan una lista YAML en la raíz o las claves `paths` y `files`.

La herramienta `read` está permitida. Cualquier otra herramienta que exponga el archivo en argumentos como `path`, `file`, `target`, `destination`, `directory` o sus plurales queda bloqueada. Para `bash`, el hook revisa los paths escritos explícitamente en el comando. El YAML se recarga antes de cada llamada y el propio archivo de política queda protegido.

Para usar otro archivo:

```bash
pi --protected-paths-config config/locked-files.yaml
```

El análisis de `bash` no puede resolver referencias indirectas construidas con variables, enlaces creados durante el comando o sustituciones dinámicas. Para aislamiento fuerte frente a shell arbitrario hace falta complementar este hook con un sandbox del sistema operativo.

## Perfiles de tema

`theme-map` selecciona temas disponibles en Pi mediante un mapa YAML del proyecto. No requiere que las demás extensiones importen helpers y aplica el tema sólo durante la sesión, sin modificar la preferencia global.

Si el proyecto no contiene el YAML, la extensión queda inactiva. Un archivo existente pero inválido sí se reporta como error.

El archivo predeterminado es `.pi/theme-map.yaml`; hay una plantilla reutilizable en `examples/theme-map.yaml`. El paquete incluye los perfiles `dark` y `pixel-green`:

```yaml
activeProfile: dark
fallbackTheme: dark

profiles:
  dark:
    theme: dark
    title: "π - dark"

  pixel-green:
    theme: pixel-green
    title: "π - pixel green"
```

`dark` usa el tema incorporado de Pi. `pixel-green` está incluido en `themes/pixel-green.json` y utiliza fondos casi negros con una paleta verde fósforo de alto contraste.

Para inicializar otro proyecto:

```bash
mkdir -p .pi
cp /ruta/a/PiCommon/examples/theme-map.yaml .pi/theme-map.yaml
```

La selección inicial sigue este orden:

1. `--theme-profile <nombre>`.
2. `activeProfile` en el YAML.
3. Primera extensión pasada con `-e` cuyo nombre coincida con un perfil.
4. `defaultProfile` en el YAML.

`/theme-map` abre el selector. También acepta `/theme-map <perfil>`, `/theme-map reload` y `/theme-map reset`. Los temas referenciados deben estar cargados por Pi desde el proyecto, otro paquete o el propio paquete central.

## Compuerta de autorización del provider

`provider-gate` intercepta cada payload mediante `before_provider_request` y pausa la llamada hasta recibir una decisión humana. Inicia una UI HTTP efímera en `127.0.0.1`, abre el navegador y muestra el JSON serializado completo junto con `COPY`, `EDIT`, `ACCEPT` y `REJECT`. La barra lateral colapsable permite saltar entre requests por su número de secuencia.

Cada tarjeta separa tres vistas: `RAW PI` contiene el payload reconstruido por Pi antes de aplicar políticas, `SENT` contiene el objeto que se libera al provider y `USER` extrae el último elemento humano de `input` con fallback para `messages` y `contents`.

Las ediciones dentro del array de conversación se guardan en un ledger de proyección. `DROP LAST TURN` conserva el prompt actual y prepara la eliminación de la interacción completa inmediatamente anterior, incluidos sus eventos de tools asociados para no producir referencias huérfanas. Las operaciones sólo se comprometen al presionar `ACCEPT`; `REJECT` descarta el draft completo. En N+1 el ledger reconoce los elementos originales y vuelve a aplicar reemplazos y eliminaciones antes de mostrar y enviar `SENT`.

Los cambios fuera de `input`, `messages` o `contents`, como `temperature`, son propios de esa request y aparecen marcados como `REQUEST-ONLY`. Cambiar manualmente la longitud del array tampoco se persiste; para eliminar turnos debe utilizarse `DROP LAST TURN`.

La compuerta se activa y desactiva durante la sesión con `/gate-on` y `/gate-off`. Al desactivarla, cualquier aprobación pendiente se libera y las requests posteriores pasan sin espera, pero el ledger continúa aplicándose para no reintroducir contexto eliminado.

La URL incluye un token aleatorio por sesión y el servidor no escucha en interfaces externas. El payload puede contener prompts, mensajes, resultados de herramientas, imágenes codificadas y otros datos sensibles; no debe compartirse la URL.

Opciones:

```bash
pi --provider-gate-port 47831
pi --provider-gate-no-open
```

`0`, el puerto predeterminado, selecciona un puerto libre. `/provider-gate` vuelve a abrir la interfaz. `EDIT` habilita un editor del payload completo; `ACCEPT` valida el texto como JSON y, si fue modificado, devuelve el objeto resultante para que Pi lo use como reemplazo. Un JSON inválido mantiene la llamada pausada. Al rechazar, la extensión llama `ctx.abort()` antes de devolver el control al provider. Al presionar Escape o cerrar la sesión, las revisiones pendientes se cancelan.

Sólo se detienen payloads cuyo elemento final representa un mensaje humano. Las continuaciones cuyo último elemento es `function_call`, `function_call_output`, `tool_call` o `tool_result` pasan sin aprobación, aunque reciben la proyección acumulada antes del envío; el control específico de tools queda fuera de esta extensión.

El ledger se persiste como una entrada custom de Pi que no participa en el contexto y se restaura al reabrir la misma rama. La sesión canónica permanece append-only: `RAW PI` puede seguir conteniendo el texto original, mientras que `SENT` refleja la conversación virtual efectiva. Un cambio de provider o una compactación que reserialice el contexto con otra estructura puede hacer que una identidad anterior deje de coincidir; `RAW PI` permite detectar esa situación. La UI conserva hasta doce requests en memoria y no escribe sus snapshots a disco.

## Provider wire debug

`provider-wire-debug` es un reverse proxy HTTP de diagnóstico, desactivado por defecto. Al habilitarlo reemplaza temporalmente el `baseUrl` del modelo activo por un servidor en `127.0.0.1`, registra el request recibido después de la serialización del SDK y lo reenvía al upstream original.

```bash
pi --wire-debug
```

La captura se agrega como JSONL en `.pi/provider-wire-debug.jsonl`. Cada request incluye método, URL, headers, body UTF-8, tamaño y SHA-256; luego se agrega el status de la respuesta con el mismo ID. `/wire-debug` muestra el upstream y archivo activos.

Opciones:

```bash
pi --wire-debug-port 47832
pi --wire-debug-log .pi/my-wire-log.jsonl
pi --wire-debug-upstream https://api.openai.com/v1
pi --wire-debug-show-secrets
```

Los headers de autenticación, cookies, API keys y tokens se redactan por defecto. El body no se redacta y puede contener el contexto completo, imágenes y resultados de tools. `--wire-debug-show-secrets` debe utilizarse sólo en un entorno controlado y el archivo debe eliminarse después de la prueba.

Para validar la proyección, aceptar una llamada N después de editarla o ejecutar `DROP LAST TURN`, y comparar los registros `request` de N y N+1. El body de N+1 debe conservar el reemplazo y omitir los elementos eliminados, incluso cuando `RAW PI` todavía los contenga.

El proxy captura tráfico HTTP/SSE. Para providers con múltiples transportes se debe configurar `transport: "sse"` durante la prueba. El proxy cambia el host de destino y Node puede recalcular headers de transporte como `host`, `content-length` o `accept-encoding`; el body y los headers de aplicación recibidos desde el SDK se conservan.
