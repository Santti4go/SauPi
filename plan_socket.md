# Plan de implementación: monitor y coordinador híbrido para sesiones Pi

## 1. Objetivo

Construir un sistema local que permita:

1. Descubrir las sesiones Pi TUI activas que tengan esta extensión habilitada y compartan usuario y namespace de runtime, aunque estén en distintos directorios. No se detectan automáticamente procesos sin extensión, otros usuarios ni otros contenedores.
2. Consultar su estado en tiempo real:
   - sesión y directorio
   - nombre
   - modelo
   - idle/running/waiting
   - PID y tiempo de actividad
3. Enviar mensajes entre sesiones TUI.
4. Crear y controlar nuevas sesiones headless mediante RPC.
5. Presentar TUI y RPC bajo una interfaz común para el coordinador.
6. Recuperarse correctamente de cierres, crashes y registros obsoletos.

El alcance inicial es Linux/macOS con Unix domain sockets. Windows requeriría named pipes o TCP local.

**MVP de identificación:** fase 0, fase 1 y `list/watch/inspect` de fase 3, sin daemon obligatorio ni mensajes al LLM. Comunicación, dashboard y supervisor RPC son ampliaciones independientes; no deben bloquear la identificación.

**Base revisada:** `@earendil-works/pi-coding-agent` 0.85.1 instalada. Validar tipos y pruebas de integración contra esta versión y documentar versiones soportadas; no asumir compatibilidad con otras distribuciones de Pi.

---

# 2. Restricciones de Pi relevantes

## Sesiones guardadas no equivalen a sesiones activas

```ts
await SessionManager.listAll()
```

enumera archivos de sesión, pero no indica si actualmente existe un proceso usando cada sesión.

Por eso, la detección de sesiones vivas debe implementarse mediante registro activo y heartbeat.

## Las TUI no exponen RPC

Una sesión iniciada normalmente con:

```bash
pi
```

no puede controlarse externamente mediante stdin/stdout JSONL. Necesita una extensión que abra un canal IPC.

## El event bus no cruza procesos

```ts
pi.events.emit(...)
```

sirve para comunicación entre extensiones cargadas en el mismo proceso Pi, no entre distintas terminales.

## Ciclo de vida de extensiones

Los recursos persistentes deben abrirse en `session_start`, no en la factory de la extensión, y cerrarse en `session_shutdown`.

Los cambios `/new`, `/resume`, `/fork`, `/clone` reemplazan el runtime y vuelven obsoletos los objetos del contexto anterior.

---

# 3. Arquitectura propuesta

```text
                         ┌─────────────────────────┐
                         │      Coordinador        │
                         │                         │
                         │ registry / monitor      │
                         │ RPC supervisor          │
                         │ router                  │
                         └───────────┬─────────────┘
                                     │
                 Unix sockets        │       stdin/stdout JSONL
                                     │
          ┌──────────────────────────┴─────────────────────────┐
          │                                                    │
┌─────────▼──────────┐                              ┌──────────▼─────────┐
│ Pi TUI             │                              │ Pi RPC             │
│ proyecto backend   │                              │ proceso hijo       │
│                    │                              │                    │
│ extensión global   │                              │ controlado por el  │
│ + Unix socket      │                              │ coordinador        │
└────────────────────┘                              └────────────────────┘

┌────────────────────┐
│ Pi TUI             │
│ proyecto frontend  │
│ extensión global   │
│ + Unix socket      │
└────────────────────┘
```

## Componentes

### A. Extensión global `pi-session-network`

Se carga en cada TUI y:

- abre un Unix socket
- publica metadata
- mantiene heartbeat
- actualiza el estado
- recibe mensajes
- registra comandos y tools para descubrir/contactar otras sesiones
- limpia sus recursos durante shutdown

### B. Coordinador

Proceso Node.js independiente que:

- descubre endpoints TUI
- monitoriza su estado
- limpia registros obsoletos
- envía mensajes
- crea procesos Pi RPC
- consume eventos RPC
- presenta todos los agentes mediante un modelo común

### C. Protocolo compartido

Define:

- metadata del endpoint
- requests y responses
- estados
- mensajes
- errores
- versionado
- límites y validación

### D. Adaptador RPC

Convierte el protocolo común del coordinador en comandos Pi RPC:

```text
deliver  → prompt / steer / follow_up
state    → get_state
abort    → abort
```

---

# 4. Identidad: sesión versus proceso vivo

No se debe usar únicamente `sessionId` como identificador del endpoint.

Una misma sesión podría:

- abrirse accidentalmente en dos procesos
- ser reemplazada mediante `/new` o `/resume`
- mantener el mismo PID después de reemplazar el runtime

Se proponen dos identificadores:

```ts
interface LiveIdentity {
  endpointId: string; // UUID de esta instancia viva
  sessionId: string;
}
```

- `sessionId`: identidad persistente de la conversación.
- `endpointId`: identidad efímera de un runtime vivo.

El registro y los sockets se nombran usando `endpointId`.

---

# 5. Directorio de runtime

Preferencia:

```text
$XDG_RUNTIME_DIR/pi-session-network/
```

Fallback:

```text
/tmp/pi-session-network-<uid>/
```

No se recomienda guardar los sockets directamente bajo rutas largas como `~/.pi/agent/...`, porque Unix sockets tienen un límite pequeño de longitud de path, normalmente alrededor de 108 bytes en Linux.

Estructura:

```text
$XDG_RUNTIME_DIR/pi-session-network/
├── registry/
│   ├── 13c91f.json
│   └── b82a10.json
├── sockets/
│   ├── 13c91f.sock
│   └── b82a10.sock
└── coordinator.sock
```

Permisos:

- directorio: `0700`
- archivos: `0600`
- aplicar modos explícitos a los recursos propios; **no cambiar `process.umask()` desde la extensión**, porque afecta todo Pi
- crear directorios y temporales exclusivamente; verificar propietario, tipo y permisos con `lstat`, rechazando symlinks en los directorios privados y archivos del protocolo
- nunca hacer `chmod` ni borrar un directorio preexistente de otro propietario; fallar con diagnóstico

Validar la longitud del path completo en **bytes UTF-8**, incluido el terminador NUL: Linux suele disponer de 108 bytes y macOS de 104. Usar un presupuesto conservador de hasta 100 bytes para el path, IDs completos y nombres de directorio más cortos si hace falta. Si XDG produce una ruta demasiado larga, usar el fallback validado.

Para terminales con entornos XDG diferentes, discovery debe consultar tanto el directorio XDG válido como el fallback conocido y deduplicar por `endpointId`. No prometer descubrimiento entre namespaces de runtime aislados.

---

# 6. Metadata de sesiones activas

Ejemplo:

```json
{
  "protocolVersion": 1,
  "endpointId": "13c91f...",
  "transport": "tui-socket",
  "pid": 24120,
  "sessionId": "a731...",
  "sessionName": "backend",
  "sessionFile": "/home/user/.pi/agent/sessions/...jsonl",
  "cwd": "/home/user/projects/backend",
  "socketPath": "/run/user/1000/pi-session-network/sockets/13c91f.sock",
  "model": {
    "provider": "anthropic",
    "id": "claude-sonnet-..."
  },
  "thinkingLevel": "medium",
  "status": "idle",
  "startedAt": 1740000000000,
  "updatedAt": 1740000030000,
  "heartbeatAt": 1740000030000
}
```

Estados normalizados:

```ts
type LiveStatus =
  | "starting"
  | "idle"
  | "running"
  | "waiting_user"
  | "compacting"
  | "retrying"
  | "shutting_down"
  | "unreachable";
```

`sessionName`, `sessionFile` y `model` pueden faltar (usar `null` en el protocolo). `startedAt` mide el inicio del endpoint; publicar `processUptimeSeconds` por separado para el uptime del proceso. `updatedAt` representa cambios de metadata, `heartbeatAt` liveness y `lastActivityAt` actividad real; un heartbeat no cuenta como actividad.

Publicar `piVersion`, `capabilities` y precisión del estado por transporte. En TUI no está disponible toda la telemetría RPC. `unreachable` es una observación del monitor, no un estado que deba escribir en la metadata del propietario.

## Escritura segura

Los archivos de metadata deben actualizarse atómicamente:

1. serializar escrituras por endpoint y coalescer actualizaciones pendientes
2. escribir un temporal único `<endpoint>.<nonce>.tmp` con creación exclusiva y modo `0600`
3. `fsync` sólo si se necesita durabilidad (registro vivo efímero)
4. renombrar a `<endpoint>.json`

Durante shutdown, impedir nuevas escrituras, esperar la escritura en curso y recién después eliminar metadata. Ningún callback tardío debe recrear el registro.

No se escribirá metadata en cada `message_update`, porque produciría demasiada I/O. Sólo en transiciones relevantes y en heartbeat.

---

# 7. Extensión TUI

Ubicación inicial:

```text
~/.pi/agent/extensions/pi-session-network/index.ts
```

Para una distribución posterior, convertirla en un paquete Pi instalable.

## APIs de extensión que se utilizarán

### Ciclo de vida

```ts
pi.on("session_start", ...)
pi.on("session_shutdown", ...)
```

### Estado del agente

```ts
pi.on("agent_start", ...)
pi.on("agent_settled", ...)
pi.on("ui_prompt_start", ...)
pi.on("ui_prompt_end", ...)
pi.on("session_before_compact", ...)
pi.on("session_compact", ...)
pi.on("session_compact_failed", ...)
pi.on("model_select", ...)
pi.on("thinking_level_select", ...)
pi.on("session_info_changed", ...)
```

`compaction_start/end` y `auto_retry_start/end` son eventos de `AgentSession`/RPC, **no de `ExtensionAPI.on` en 0.85.1**. No registrar esos hooks en la extensión. El estado TUI de compacción será best-effort (un hook previo puede ser cancelado); retry se reportará como ocupado mediante `ctx.isIdle()`, sin inventar un estado `retrying` preciso.

Derivar estado con flags: shutdown > prompt UI activo > compacción observada > ocupado > idle. Al cerrar un diálogo recalcular, no asignar `idle` ciegamente. `waiting_user` cubre diálogos de extensiones observables, no todos los selectores internos ni preguntas del asistente. Reconciliar en heartbeat usando el contexto vigente y `ctx.isIdle()`; no cachear valores iniciales de modelo/estado.

### Recepción de mensajes

```ts
pi.sendUserMessage(...)
```

### Integración con usuario y modelo

```ts
pi.registerCommand(...)
pi.registerTool(...)
ctx.ui.notify(...)
ctx.ui.setStatus(...)
```

## Inicio

En `session_start`:

0. Retornar si `ctx.mode !== "tui"`. `ctx.hasUI` no sirve como filtro: también es true en RPC. Evitar así registrar dos endpoints para hijos RPC.
1. Crear un `endpointId`.
2. Capturar datos de:
   - `process.pid`
   - `ctx.cwd`
   - `ctx.sessionManager.getSessionId()`
   - `ctx.sessionManager.getSessionFile()`
   - `pi.getSessionName()`
   - `ctx.model`
   - `ctx.thinkingLevel`
3. Crear el Unix server, esperar `listening` y establecer permisos; si falla, revertir todos los recursos creados y notificar sin impedir usar Pi.
4. Publicar metadata sólo cuando el socket esté listo.
5. Iniciar heartbeat.
6. Derivar estado actual con `ctx.isIdle()` y los flags observados, no forzar `idle`.
7. Mostrar opcionalmente un estado:
   ```ts
   ctx.ui.setStatus("session-network", "network: online");
   ```

## Shutdown

En `session_shutdown`:

1. Marcar `shutting_down`.
2. Detener heartbeat.
3. Rechazar requests nuevos.
4. Cerrar conexiones.
5. Cerrar el servidor.
6. Eliminar socket.
7. Eliminar metadata.
8. Limpiar el status de la UI.

El handler debe ser idempotente porque puede ejecutarse por quit, reload, new, resume o fork. Mantener un conjunto de conexiones para destruirlas y un plazo máximo de cierre; `server.close()` por sí solo puede esperar indefinidamente. Cancelar handlers pendientes y protegerlos con una generación/flag cerrado antes de usar `pi` o `ctx`.

## Reemplazo de sesión

Después de `/new`, `/resume`, `/fork` o `/clone`, Pi crea una nueva instancia de la extensión.

Por tanto:

- no se reutiliza el `ctx` anterior
- el endpoint anterior se destruye
- se publica un nuevo `endpointId`
- el coordinador observa que desapareció un endpoint y apareció otro

---

# 8. Protocolo sobre Unix sockets

Formato JSONL UTF-8, un objeto por línea terminada en LF. Decodificar incrementalmente sin romper caracteres multibyte, aceptar CRLF y no separar por U+2028/U+2029. Una línea incompleta al cerrar el socket es inválida.

Limitar bytes por frame (64 KiB incluyendo metadata), conexiones, requests simultáneos, colas y buffers de salida; aplicar backpressure y deadline de frame incompleto. `ping/get_info` no deben esperar detrás de entregas o diálogos. Correlacionar respuestas por `id`, validar versión/identidad en respuestas y devolver errores estables (`UNSUPPORTED_VERSION`, `FORBIDDEN`, `BUSY`, `TOO_LARGE`, `ENDPOINT_CHANGED`).

Las requests con efectos deben incluir `targetEndpointId`; rechazar si no corresponde al runtime actual. Un timeout después de enviar implica resultado desconocido, no autorización para repetir con otro `messageId`.

## Request

```json
{
  "v": 1,
  "id": "req-123",
  "method": "deliver",
  "params": {
    "messageId": "msg-456",
    "text": "Revisa el contrato de autenticación",
    "delivery": "followUp",
    "source": {
      "endpointId": "abc...",
      "sessionId": "def...",
      "name": "orchestrator"
    },
    "hopCount": 0
  }
}
```

## Response

```json
{
  "v": 1,
  "id": "req-123",
  "ok": true,
  "result": {
    "accepted": true,
    "stage": "bridge_dispatched",
    "messageId": "msg-456"
  }
}
```

Error:

```json
{
  "v": 1,
  "id": "req-123",
  "ok": false,
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Missing params.text"
  }
}
```

## Métodos del MVP

### `ping`

Comprueba que el endpoint realmente está vivo.

### `get_info`

Obtiene la identidad y metadata actual directamente del proceso.

### `deliver`

Entrega un mensaje a la sesión.

### `notify`

Muestra una notificación sin iniciar un turno del LLM.

## Métodos posteriores

- `subscribe`
- `abort`
- `get_last_assistant_text`
- `request_reply`
- `broadcast`
- `shutdown`

No conviene exponer ejecución arbitraria de shell.

---

# 9. Semántica de entrega de mensajes

Usar siempre modo explícito, tanto idle como busy:

```ts
pi.sendUserMessage(text, {
  deliverAs: delivery === "steer" ? "steer" : "followUp",
  expandPromptTemplates: false,
});
```

En 0.85.1 se entrega inmediatamente si no hay streaming; `deliverAs` define cómo encolar si lo hay. No hace falta el fallback check/try/retry.

**Limitación crítica:** `ExtensionAPI.sendUserMessage()` retorna `void`; el runtime captura los errores asíncronos y los comunica como errores de extensión. Ni `await` ni `try/catch` confirman el preflight de Pi. No reintentar suponiendo que una excepción asíncrona será observable. Probar entregas durante retry, compacción y diálogos; si la API no garantiza una entrega en esos estados, rechazarlas como `BUSY` antes del despacho en vez de prometer encolado.

Default recomendado:

```text
followUp
```

Así una sesión no interrumpe inesperadamente el trabajo de otra.

## Contexto de procedencia

El mensaje recibido debe marcar claramente su origen:

```text
[Mensaje de otra sesión Pi]
Source endpoint: backend
Source session: a731...
Message ID: msg-456

Revisa el contrato de autenticación.
```

Esto evita confundirlo con texto introducido directamente por el usuario.

## Confirmación

El ACK significa:

> El puente aceptó la solicitud y la despachó a la API de Pi (`stage: "bridge_dispatched"`).

En TUI **no confirma aceptación/encolado por Pi**. No devolver `queued: true` deducido de `isIdle()`. En RPC, la respuesta exitosa de `prompt` sí permite `stage: "pi_accepted"` (aceptado, encolado o manejado por una extensión). Exponer esta diferencia en el protocolo común.

No significa:

> La tarea terminó correctamente.

La espera de resultados se implementará por separado.

---

# 10. Herramientas y comandos TUI

## Comandos para el usuario

```text
/pi-sessions
/pi-send <endpoint|name> <mensaje>
/pi-whoami
```

### `/pi-sessions`

Muestra:

```text
NAME       STATUS    CWD                           MODEL
backend    running   ~/projects/backend            anthropic/...
frontend   idle      ~/projects/frontend           openai/...
```

### `/pi-send`

Resuelve el endpoint y envía el mensaje. Si hay nombres duplicados, debe pedir selección mediante `ctx.ui.select()`.

## Tools para el modelo

Se recomiendan dos tools separadas:

### `list_live_pi_sessions`

Sólo lectura. Devuelve endpoints, estado y cwd.

### `send_to_pi_session`

Parámetros:

```ts
{
  target: string;
  message: string;
  delivery?: "steer" | "followUp";
}
```

No debe permitir broadcast en el MVP.

El resultado debe truncarse según los límites estándar de Pi. La tool debe devolver error de destino ambiguo con candidatos, nunca escoger arbitrariamente. Los comandos humanos pueden abrir selector. Rechazar autoenvío en el MVP.

---

# 11. Descubrimiento y limpieza de endpoints

El coordinador y la extensión usarán un algoritmo común:

1. Enumerar `registry/*.json`.
2. Validar esquema y versión.
3. Comprobar antigüedad del heartbeat como indicio, nunca como prueba de muerte.
4. Consultar PID con `process.kill(pid, 0)` como dato auxiliar: `EPERM` no significa muerto; `ESRCH` indica que no existe.
5. Derivar el socket del directorio validado y `endpointId`, no confiar en un `socketPath` arbitrario del JSON; comprobar tipo/propietario.
6. Conectar y ejecutar `ping`, aunque el heartbeat parezca viejo.
7. Verificar versión y `endpointId` devueltos. Si responde, conservar y reconciliar.
8. Si falla, marcar `unreachable` sólo en el catálogo local.
9. Un único recolector por directorio, protegido por exclusión mutua, puede limpiar tras el período de gracia y fallos repetidos. Antes de borrar, releer metadata, verificar que no avanzó su revisión/heartbeat y repetir el probe. No borrar por timeout un proceso existente (por ejemplo SIGSTOP, suspensión o event loop bloqueado); conservarlo como unreachable. Ante identidad diferente, permisos insuficientes o propiedad dudosa, no borrar.

Los listados de extensiones son sólo lectura; el propietario limpia sus recursos y `pi-coordinator gc` o el daemon ejecutan el recolector común. Los sockets huérfanos sin metadata sólo se recolectan con prueba conservadora de ausencia de listener y antigüedad suficiente; nunca hacer unlink preventivo al iniciar un endpoint.

El PID por sí solo no es suficiente por la reutilización de PIDs. El handshake con `endpointId` evita falsos positivos.

Valores iniciales sugeridos:

```text
heartbeat interval: 5 segundos
stale warning:      15 segundos
stale removal:      60 segundos
request timeout:    3 segundos
max request size:   64 KiB
```

---

# 12. Coordinador

## Responsabilidades

1. Mantener un catálogo unificado de endpoints.
2. Observar cambios con:
   - `fs.watch` como optimización
   - reconciliación periódica como mecanismo confiable
3. Verificar liveness.
4. Mostrar un dashboard.
5. Enviar mensajes a TUI.
6. Crear y supervisar procesos RPC.
7. Traducir eventos RPC al estado común.
8. Limpiar procesos y sockets durante shutdown.

## Modelo de proceso

`list/watch/inspect` pueden leer directamente el registro sin daemon. Para `spawn/stop` se requiere un supervisor persistente: añadir `pi-coordinator serve`, único por directorio mediante lock y handshake en `coordinator.sock`. Las invocaciones CLI son clientes; terminar `watch` no termina agentes.

En cierre normal de `serve`, terminar sólo sus hijos RPC (cancelar diálogos, limpiar colas, abortar, SIGTERM y SIGKILL tras plazos limitados), nunca las TUI descubiertas. Un crash no permite readoptar stdin/stdout desde otro proceso: no prometer recuperación de esos hijos; detectar huérfanos sin señalar PIDs no verificados. Supervisión externa/grupos de procesos con contención verificable se requiere si se quiere garantizar ausencia de huérfanos tras SIGKILL.

## Interfaz CLI inicial

```bash
pi-coordinator list
pi-coordinator watch
pi-coordinator inspect <endpoint>
pi-coordinator send <endpoint> "mensaje"
pi-coordinator spawn --cwd ~/projects/backend --name backend-worker
pi-coordinator abort <endpoint>
pi-coordinator stop <endpoint>
```

Salida de `watch`:

```text
ENDPOINT   TYPE   NAME       STATUS    PID     CWD
13c91f     TUI    backend    running   24120   ~/projects/backend
28fb40     TUI    frontend   idle      24192   ~/projects/frontend
71abc2     RPC    reviewer   idle      24901   ~/projects/review
```

---

# 13. Integración RPC

## Creación de agentes

El coordinador ejecuta:

```ts
spawn("pi", ["--mode", "rpc", "--name", name], {
  cwd,
  stdio: ["pipe", "pipe", "pipe"],
});
```

No se usará `--no-session` si queremos que la nueva sesión sea persistente.

Después del arranque:

```json
{"id":"startup-state","type":"get_state"}
```

El coordinador obtiene `sessionId`, `sessionFile`, modelo y estado.

## Transporte

RPC usa JSONL:

- comandos por `stdin`
- responses y eventos por `stdout`
- logs/errores por `stderr`

El parser debe separar exclusivamente por `\n`; no se debe usar `readline`, porque la documentación de Pi advierte que también puede separar por caracteres Unicode válidos dentro de JSON.

## Mapeo común

| Operación común | TUI socket | Pi RPC |
|---|---|---|
| ping | `ping` | proceso vivo + `get_state` |
| info | `get_info` | `get_state` |
| send idle | `deliver` | `prompt` |
| send busy | `deliver` | `prompt` con `streamingBehavior` |
| steer | `deliver` | `steer` |
| follow-up | `deliver` | `follow_up` |
| abort | opcional | `abort` |
| last response | futuro | `get_last_assistant_text` |

## Eventos RPC utilizados

- `agent_start` → `running`
- `agent_settled` → `idle`
- `compaction_start` → `compacting`
- `auto_retry_start` → `retrying`
- `extension_ui_request` de diálogo → `waiting_user`
- `compaction_end` / `auto_retry_end` → quitar flag y recalcular, no asignar idle automáticamente
- salida del proceso → retirar endpoint y registrar exit en historial

Cancelar automáticamente diálogos RPC no atendidos con `extension_ui_response` y `cancelled: true`, con deadline; jamás confirmar permisos automáticamente. Consumir continuamente stdout y stderr con buffers acotados. El límite RPC debe ser independiente de los 64 KiB del IPC: resultados y eventos Pi pueden ser mucho mayores.

Para `deliver` usar `prompt` con `streamingBehavior` explícito también en idle; aplicar el prefijo de procedencia generado por el puente antes del texto para que no comience con un slash command. Para semántica de cancelación tipo Esc, enviar `clear_queue` antes de `abort`: `abort` solo puede continuar mensajes pendientes.

Después de reemplazos de sesión RPC, consultar `get_state`, retirar el proxy anterior y rotar `endpointId` al detectar nueva sesión; el mismo PID no implica el mismo runtime.

---

# 14. Unificación de TUI y RPC

Para que otros clientes no tengan que saber qué transporte usa cada endpoint, el coordinador puede crear un Unix socket proxy para cada agente RPC.

```text
cliente
   │
   │ protocolo común
   ▼
RPC proxy socket
   │
   │ JSONL Pi RPC
   ▼
proceso pi --mode rpc
```

La metadata RPC tendría:

```json
{
  "endpointId": "...",
  "transport": "rpc-proxy",
  "socketPath": "...",
  "managedBy": "coordinator",
  "pid": 24901,
  "sessionId": "...",
  "cwd": "...",
  "status": "idle"
}
```

Así `send_to_pi_session` usa siempre el mismo protocolo Unix independientemente de si el destino es TUI o RPC.

---

# 15. Monitorización

## Datos mínimos

- endpoint ID
- session ID
- nombre
- transporte
- cwd
- session file
- PID
- modelo y thinking level
- estado
- última actividad
- heartbeat
- mensajes pendientes si está disponible

## Estados derivados

El monitor no debe inferir actividad leyendo continuamente el JSONL de sesión. Usará eventos y heartbeats.

Los archivos de sesión pueden emplearse para información histórica, pero no como fuente de liveness.

## Persistencia

El catálogo vivo es efímero. El coordinador puede mantener un historial separado opcional:

```text
~/.pi/agent/coordinator/history.jsonl
```

Eventos:

- endpoint discovered
- endpoint lost
- task sent
- RPC spawned
- RPC exited
- error

Nunca deben guardarse prompts completos por defecto, porque pueden contener información sensible.

---

# 16. Seguridad

## Modelo de confianza

Los permisos Unix aíslan de otros usuarios, **no de procesos del mismo UID ni de root**. `source.endpointId`, nombre y `hopCount` declarados por el cliente no autentican al emisor. El handshake verifica identidad de destino/liveness, no identidad de origen. Una allowlist basada sólo en esos campos no es una barrera de seguridad; etiquetarlos como procedencia declarada.

MVP en modo sólo lectura/`notify-only`, con `deliver` habilitado explícitamente en el receptor. Permisos y allowlists evitan errores entre clientes cooperativos; aislar agentes hostiles del mismo usuario requiere separación de usuarios/sandbox y queda fuera del MVP. Sanitizar controles ANSI/OSC y saltos de línea en metadata mostrada en terminales.

## Aislamiento local

- directorio `0700`
- sockets `0600`
- bind sólo mediante Unix socket
- no TCP en el MVP
- validar UID cuando la plataforma lo permita

## Validación

- schemas estrictos
- versión obligatoria
- límite de 64 KiB
- timeout
- longitud máxima de mensaje
- métodos allowlisted
- rechazar campos inesperados si se decide un protocolo estricto

## Riesgo de prompts remotos

Enviar un mensaje a otra sesión puede provocar que el agente use tools y modifique archivos.

Medidas:

1. Mostrar claramente el origen.
2. Permitir bloquear mensajes automáticos.
3. Configurar una allowlist de endpoints.
4. Añadir modo `notify-only`.
5. Registrar quién envió cada mensaje.
6. No aceptar comandos shell mediante IPC.
7. Considerar confirmación humana para `send_to_pi_session` iniciado por el modelo.

## Prevención de bucles

Cada mensaje incluye:

```ts
{
  messageId: string;
  hopCount: number;
  replyTo?: string;
}
```

Reglas:

- rechazar `hopCount > 3`
- mantener cache acotada por `(targetEndpointId, messageId)`, con hash del payload y resultado durante al menos 10 minutos
- reservar el ID antes de despachar; duplicados concurrentes comparten resultado y no provocan otra entrega
- devolver el mismo ACK para idéntico payload; mismo ID con payload distinto devuelve `ID_CONFLICT`
- no prometer exactly-once ni durabilidad tras crash/reload o expiración del cache
- no reenviar automáticamente respuestas en el MVP
- no permitir broadcast inicialmente

---

# 17. Estructura del proyecto

```text
pi-session-network/
├── package.json
├── tsconfig.json
├── src/
│   ├── shared/
│   │   ├── protocol.ts
│   │   ├── schemas.ts
│   │   ├── runtime-dir.ts
│   │   ├── registry.ts
│   │   └── jsonl.ts
│   ├── extension/
│   │   ├── index.ts
│   │   ├── live-server.ts
│   │   ├── state-tracker.ts
│   │   ├── commands.ts
│   │   └── tools.ts
│   └── coordinator/
│       ├── cli.ts
│       ├── coordinator.ts
│       ├── discovery.ts
│       ├── router.ts
│       ├── rpc-process.ts
│       ├── rpc-jsonl-client.ts
│       ├── rpc-proxy.ts
│       └── dashboard.ts
└── test/
    ├── protocol.test.ts
    ├── registry.test.ts
    ├── extension-server.test.ts
    ├── discovery.test.ts
    ├── rpc-client.test.ts
    └── integration/
```

La extensión puede exponerse mediante:

```json
{
  "pi": {
    "extensions": ["./dist/extension/index.js"]
  }
}
```

Durante desarrollo puede cargarse con:

```bash
pi -e ./src/extension/index.ts
```

Para uso real debe instalarse globalmente o quedar en:

```text
~/.pi/agent/extensions/
```

---

# 18. Fases de implementación

## Fase 0 — Especificación

Entregables:

- protocolo v1
- schemas
- estados
- política de seguridad
- semántica de ACK
- decisión sobre runtime directory

Criterio de aceptación:

- protocolo revisado antes de escribir integración Pi

## Fase 1 — Registro y socket TUI

Implementar:

- extensión global
- Unix server
- metadata atómica
- heartbeat
- `ping`
- `get_info`
- cleanup en shutdown

Criterios:

- dos TUI en directorios distintos aparecen en el registro
- `/reload` no deja sockets obsoletos
- `/new` reemplaza correctamente el endpoint
- un kill abrupto es detectado como stale

## Fase 2 — Comunicación entre TUI

Implementar:

- `deliver`
- `/pi-sessions`
- `/pi-send`
- `list_live_pi_sessions`
- `send_to_pi_session`
- deduplicación y hop limit

Criterios:

- TUI A envía un follow-up a TUI B
- B muestra el origen
- enviar a un endpoint caído devuelve error claro
- nombres duplicados requieren selección explícita

## Fase 3 — Coordinador y dashboard

Implementar:

- discovery
- reconciliación
- monitor `list/watch`
- routing
- limpieza de stale entries
- historial sin contenido sensible

Criterios:

- monitoriza altas, bajas y cambios de estado
- no depende de cwd
- se recupera si el coordinador se reinicia

## Fase 4 — Supervisor RPC

Implementar:

- spawn de Pi RPC
- parser JSONL correcto
- correlación por request ID
- eventos
- estado
- prompt/follow-up/abort
- cierre del proceso

Criterios:

- crear una sesión RPC en un cwd indicado
- verla junto a las TUI
- enviar tarea y recibir streaming
- abortar limpiamente
- detectar exit inesperado

## Fase 5 — Proxy RPC unificado

Implementar:

- socket proxy por endpoint RPC
- metadata común
- routing transparente

Criterio:

- un cliente puede enviar `deliver` sin saber si el destino es TUI o RPC

## Fase 6 — Request/reply y delegación

Implementar opcionalmente:

- `request_reply`
- asociación de mensaje con ejecución
- respuesta cuando llega `agent_settled`
- timeout
- cancelación
- `get_last_assistant_text`

Esta fase requiere cuidado en TUI porque puede haber prompts ya encolados y no siempre es trivial asociar un `agent_settled` con un mensaje concreto.

---

# 19. Estrategia de pruebas

## Unitarias

- framing JSONL fragmentado
- múltiples mensajes por chunk
- JSON inválido
- request demasiado grande
- validación de schemas
- atomic writes
- deduplicación
- hop limit
- transición de estados, diálogo que termina mientras el agente sigue ocupado
- ACK TUI sin confirmación de preflight; ACK perdido y reintento con mismo ID
- escrituras concurrentes y heartbeat en vuelo durante shutdown

## Integración IPC

- dos servidores fake
- endpoint stale
- PID reutilizado con endpoint ID distinto
- socket presente sin proceso
- metadata presente sin socket
- timeout y conexión cortada
- SIGSTOP por más de 60 s y SIGCONT: no eliminar endpoint vivo
- suspensión del equipo y saltos del reloj: usar tiempo monotónico para plazos locales
- dos recolectores simultáneos, registro actualizado durante recolección
- XDG ausente/distinto, ruta multibyte larga y fallback macOS

## Integración Pi TUI

- startup
- reload
- new session
- resume
- fork
- shutdown normal
- SIGTERM
- kill abrupto

## Integración RPC

- spawn
- get_state
- prompt
- streaming
- follow_up
- abort
- proceso que termina inesperadamente
- stderr con errores
- sesión persistente
- extensión global cargada en RPC sin duplicar endpoint
- diálogo RPC sin operador, cancelación con cola pendiente y cambio de sesión
- caída del supervisor: no readoptar pipes ni matar procesos por PID reutilizado

## Seguridad

- permisos
- mensajes sobredimensionados
- método desconocido
- paths manipulados
- socket symlink
- mensajes duplicados
- loops entre endpoints

---

# 20. Decisiones recomendadas para el MVP

1. Usar Unix socket directo para TUI.
2. Usar `$XDG_RUNTIME_DIR` como directorio primario.
3. Registro distribuido mediante archivos JSON atómicos.
4. Heartbeat cada 5 segundos.
5. `followUp` como entrega predeterminada.
6. ACK distingue despacho del puente TUI de aceptación Pi RPC; nunca significa finalización.
7. Sin respuesta automática entre agentes inicialmente.
8. Sin broadcast.
9. Sin comandos shell por IPC.
10. Coordinador como supervisor exclusivo de los procesos RPC.
11. Proxy Unix para presentar agentes RPC con el mismo protocolo.
12. Herramientas de listado y envío separadas.
13. Usar `endpointId` distinto de `sessionId`.
14. No considerar `SessionManager.listAll()` como indicador de liveness.

---

# 21. Puntos que el agente revisor debería validar

1. Verificado en 0.85.1: `deliverAs: "followUp"` también sirve en idle; `sendUserMessage` retorna void y no confirma preflight. Falta comprobar integración durante retry/compacción/diálogos.
2. Verificado en 0.85.1: `RpcClient` está exportado públicamente. Evaluar sus opciones, deadlines y manejo UI antes de reutilizarlo; mantener cliente JSONL propio si no cubre las necesidades, sin imports internos.
3. Cómo asociar de forma fiable una entrega TUI con su respuesta final para la futura fase request/reply.
4. Comportamiento exacto del runtime durante `/reload`, `/new` y `/resume`.
5. Longitud máxima portable de Unix socket y elección del runtime directory.
6. Política para sesiones duplicadas que abren el mismo archivo JSONL.
7. Si el coordinador debe conservar o terminar procesos RPC al cerrarse.
8. Si los envíos iniciados por una tool requieren confirmación humana por defecto.
9. Compatibilidad macOS y estrategia futura para Windows.
10. Si conviene empaquetar extensión y coordinador juntos o como dos paquetes independientes.
