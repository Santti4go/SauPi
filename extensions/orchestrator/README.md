# Orchestrator

`orchestrator` distribuye tareas entre agentes especializados definidos por el
proyecto. Cada rol puede tener varias instancias, un prompt propio, tools,
modelo, lifecycle y política de workspace.

## Configuración

El archivo predeterminado es `.pi/orchestrator.yaml`. Para inicializar un
proyecto desde este paquete:

```bash
mkdir -p .pi/agents
cp /ruta/a/PiCommon/examples/orchestrator.yaml .pi/orchestrator.yaml
cp /ruta/a/PiCommon/examples/orchestrator/agents/*.md .pi/agents/
cp /ruta/a/PiCommon/examples/theme-map.yaml .pi/theme-map.yaml
```

Si `PiCommon` está instalado como paquete central, el proyecto puede filtrar sus
recursos en `.pi/settings.json` para cargar sólo el orquestador y sus themes:

```json
{
  "packages": [
    {
      "source": "/ruta/a/PiCommon",
      "extensions": [
        "extensions/orchestrator/index.ts",
        "extensions/theme-map/index.ts"
      ],
      "skills": [],
      "prompts": [],
      "themes": [
        "themes/pixel-green.json",
        "themes/pixel-cyan.json",
        "themes/pixel-magenta.json"
      ]
    }
  ]
}
```

Los paths normales forman una allowlist. El prefijo `+` no debe usarse solo
para este caso: fuerza una inclusión, pero sin un patrón normal conserva los
demás recursos del manifest. También puede configurarse mediante `pi config -l`
desde el proyecto.

La estructura principal es:

```yaml
version: 1
projectName: my-project

orchestrator:
  themeProfile: orchestrator
  uiTheme: orchestrator-grid

defaults:
  lifecycle: persistent
  workspace: shared
  start: lazy

agents:
  - name: developer
    description: Implementation and tests
    count: 2
    prompt: .pi/agents/developer.md
    themeProfile: developer
    workspace: worktree
    tools: read, grep, find, ls, bash, edit, write
```

Los paths relativos se resuelven desde el directorio del proyecto. Los nombres
de instancia se forman como `<name>-<N>`; en el ejemplo se crean
`developer-1` y `developer-2`.

`themeProfile` selecciona colores y títulos mediante `theme-map`. `uiTheme`
selecciona cómo el orquestador dibuja su roster dinámico:

- `orchestrator-list`: lista compacta compatible con terminales angostos.
- `orchestrator-grid`: grilla responsive de hasta tres columnas con nombre,
  estado, modelo efectivo y detalle de cada agente.

Los UI themes viven dentro de `extensions/orchestrator/ui-themes/` porque
dependen del registry del orquestador. No son themes JSON generales de Pi; se
pueden agregar nuevos renderers y seleccionarlos desde el YAML.

El prompt del rol se incorpora con `--append-system-prompt`. No reemplaza las
instrucciones generales ni los archivos `AGENTS.md` del proyecto.

## Lifecycles

### Persistent

Un agente persistente es un Pi interactivo dentro de una window tmux. Conserva
su sesión y contexto, recibe tareas por un socket Unix local y puede ser abierto
para conversar directamente con él.

Los workers se lanzan con `--no-extensions` y sólo cargan explícitamente:

- `theme-map`;
- el runtime interno `orchestrator/worker`.

Por lo tanto no cargan `provider-gate`, el orquestador principal ni otras
extensiones del proyecto.

`start: lazy` crea el worker al recibir su primera tarea. `start: eager` lo
inicia durante el arranque del orquestador.

### Ephemeral

Un agente efímero ejecuta `pi --mode json --print --no-session`, comienza con
contexto limpio y termina después de una tarea. También usa `--no-extensions`.
Es apropiado para investigación o revisiones puntuales.

## Distribución

La herramienta LLM `delegate` recibe un rol y una tarea autocontenida. El
scheduler selecciona una instancia libre y espera hasta que haya capacidad:

```json
{
  "agent": "developer",
  "task": "Implement the form validation and run its tests"
}
```

Al iniciar la sesión, la definición de `delegate` se actualiza con los nombres
exactos presentes en el YAML. Si se solicita otro nombre, el resultado enumera
los roles disponibles en vez de intentar crear un agente implícito.

La herramienta devuelve el ID concreto, resultado, workspace y branch cuando
corresponde. El progreso de tools y respuestas parciales se transmite al tool
call del orquestador.

También está disponible para uso humano:

```text
/agent-send developer Implement the validation
```

## tmux y navegación

Los workers persistentes se organizan como windows nombradas dentro de una
sesión `pi-<project>-<hash>`. Puede fijarse otro nombre con:

```yaml
tmux:
  session: pi-my-project
```

Comandos:

- `/orchestrator-init`: crea un YAML documentado y dos prompts de ejemplo sin
  sobrescribir archivos existentes; luego debe ejecutarse `/reload`.
- `/agents`: muestra el roster y estado actual.
- `/orchestrator-themes`: abre el selector de UI themes del roster.
- `/orchestrator-themes orchestrator-grid`: activa un UI theme directamente.
- `/agent-start developer-1`: inicia una instancia persistente.
- `/agent-stop developer-1`: detiene sólo su window; pide confirmación si está
  ocupado.
- `/agent-jump`: selecciona una instancia y cambia el cliente tmux a su pane.
- `/agent-jump developer-1`: salta directamente a esa instancia.
- `/agent-send <role> <task>`: delega una tarea manualmente.

La selección realizada por `/orchestrator-themes` dura durante la sesión
actual. Para establecer el valor predeterminado del proyecto debe actualizarse
`orchestrator.uiTheme` en `.pi/orchestrator.yaml`.

`Ctrl+0` abre el selector de agentes desde el orquestador. Dentro de un
worker, el mismo shortcut y `/agent-jump` regresan al pane original del
orquestador. Fuera de tmux, `/agent-jump` muestra el comando `tmux
attach-session` correspondiente.

El terminal debe transmitir `Ctrl+0` como una tecla extendida. En Windows
Terminal puede mapearse a `sendInput` con `"input": "\u001b[48;5u"`; tmux debe
tener `extended-keys on` y `extended-keys-format csi-u`.

Al cerrar Pi (`Ctrl+C`, `Ctrl+D` o una señal de terminación), el orquestador
cierra su sesión tmux y todos los workers asociados. Un `/reload`, `/new`,
`/resume` o `/fork` conserva los workers para que la nueva instancia pueda
reconectarlos.

## Heartbeats y UI

El orquestador consulta cada socket persistente cada dos segundos. El widget
muestra `starting`, `idle`, `busy`, `offline` o `failed`, junto con el task ID y
branch activos. Los fallos de heartbeat no bloquean la interfaz.

`theme-map` sigue siendo responsable únicamente de colores y títulos. El
orquestador solicita su `themeProfile` mediante el event bus de Pi; cada worker
recibe el suyo como flag explícita. El roster dinámico pertenece a esta
extensión, no al theme.

## Workspaces

- `workspace: shared` ejecuta al agente en el mismo checkout.
- `workspace: worktree` crea o reutiliza un branch `pi-agent/<instance>` y un
  Git worktree hermano bajo `.pi-worktrees/<project>/<instance>`.

La ruta puede personalizarse:

```yaml
runtime:
  directory: .pi/orchestrator
  worktreeRoot: ../my-agent-worktrees
```

Las sesiones Pi persistentes se guardan bajo `runtime.directory`. Conviene
agregar `.pi/orchestrator/` al `.gitignore` del proyecto; pueden contener
historial y datos sensibles.

## Seguridad y límites

El YAML y los prompts son código de configuración controlado por el proyecto:
pueden habilitar tools y hacer que se ejecuten procesos. La extensión debe
activarse sólo en repositorios confiables.

Los sockets se crean bajo `/tmp/pi-orchestrator-<uid>` con permisos restringidos
al usuario. No se utilizan `tmux send-keys` ni scraping de pantalla. Al cerrar el
orquestador los workers persistentes continúan vivos; se recuperan por heartbeat
al abrir otra sesión en el mismo proyecto.

Para usar otro YAML:

```bash
pi --orchestrator-config config/agents.yaml
```
