# Pi Common Harness

Paquete local de Pi con extensiones separadas y configuración de proyecto.

## Estructura

```text
extensions/
  orchestrator/     Pools de agentes efímeros y persistentes sobre tmux
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
# Desde un remoto SSH (el prefijo git: es obligatorio para el formato git@host:path)
pi install -l git:git@github.com:usuario/SauPi.git
```

`-l` instala la referencia en el `settings.json` del proyecto; no limita los
recursos del paquete. Para elegir extensiones por proyecto, ejecute
`pi config -l` o use el filtro explícito:

```json
{
  "packages": [
    {
      "source": "/ruta/a/SauPi",
      "extensions": [
        "extensions/theme-map/index.ts",
        "extensions/orchestrator/index.ts"
      ],
      "skills": [],
      "prompts": [],
      "themes": []
    }
  ]
}
```

Los paths normales forman una allowlist. Omitir una categoría carga todos sus
recursos declarados; usar `[]` no carga ninguno.

También se pueden probar directamente:

```bash
pi \
  --extension ./extensions/pi-anim/index.ts \
  --extension ./extensions/protected-paths/index.ts
```

## Animación

`pi-anim` monta el widget mientras el agente está activo, anima una señal senoidal con ruido binario y lo desmonta al finalizar. El mensaje del loader queda configurado como `PHANTOM SIGNAL // MODEL PROCESSING`.

## Orquestador

`orchestrator` distribuye tareas entre roles configurados en YAML, mantiene
workers Pi interactivos en tmux y expone agentes efímeros para tareas puntuales.

La configuración, comandos, shortcuts, worktrees y modelo de seguridad están en
[extensions/orchestrator/README.md](extensions/orchestrator/README.md).

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
cp /ruta/a/SauPi/examples/theme-map.yaml .pi/theme-map.yaml
```

La selección inicial sigue este orden:

1. `--theme-profile <nombre>`.
2. `activeProfile` en el YAML.
3. Primera extensión pasada con `-e` cuyo nombre coincida con un perfil.
4. `defaultProfile` en el YAML.

`/theme-map` abre el selector. También acepta `/theme-map <perfil>`, `/theme-map reload` y `/theme-map reset`. Los temas referenciados deben estar cargados por Pi desde el proyecto, otro paquete o el propio paquete central.

## Compuerta de autorización del provider

`provider-gate` intercepta las llamadas al LLM y permite inspeccionar, editar,
aprobar o rechazar el payload efectivo. Arranca en bypass auditado: no espera
input humano, pero registra en la UI cada request aplicable.

La documentación de comandos, `DROP LAST TURN`, persistencia y opciones está en
[extensions/provider-gate/README.md](extensions/provider-gate/README.md).

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
