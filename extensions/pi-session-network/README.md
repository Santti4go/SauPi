# Pi Session Network

Registra las TUI activas y los agentes RPC administrados, permite listarlos y
comunicarlos mediante Unix sockets. Soporta Pi **0.85.1 en Linux**.

## TUI

La extensión debe estar cargada en cada TUI que se quiera descubrir:

```bash
pi install /ruta/SauPi/extensions/pi-session-network/index.ts
```

Por seguridad, cada receptor comienza en modo sólo lectura. Para aceptar
prompts de otras sesiones:

```bash
pi --session-network-deliver
```

Comandos:

- `/pi-sessions`: lista TUI y RPC activos.
- `/pi-send <endpoint|nombre> <mensaje>`: envía un `followUp`.
- `/pi-inspect <endpoint|nombre>`: muestra metadata.
- `/pi-whoami`: muestra la identidad local.
- `/pi-gc`: elimina registros cuya antigüedad, PID y socket prueban que son
  huérfanos.

Tools del modelo: `list_live_pi_sessions` y `send_to_pi_session`. Los mensajes
se deduplican por ID durante diez minutos y no se permite broadcast ni
autoenvío. En TUI el ACK confirma el despacho al puente, no la finalización del
turno; en RPC confirma que Pi aceptó el prompt.

## Coordinador y RPC

Desde el repositorio, iniciar el supervisor persistente:

```bash
npm run coordinator -- serve
```

En otras terminales:

```bash
npm run coordinator -- list
npm run coordinator -- watch
npm run coordinator -- inspect <endpoint>
npm run coordinator -- spawn --cwd ~/proyecto --name worker
npm run coordinator -- send <endpoint> "revisá los tests"
npm run coordinator -- notify <endpoint> "mensaje"
npm run coordinator -- abort <endpoint>
npm run coordinator -- stop <endpoint>
npm run coordinator -- gc
npm run coordinator -- shutdown
```

`watch` es el dashboard de terminal. El coordinador crea procesos
`pi --mode rpc`, publica un proxy con el mismo protocolo que las TUI, cancela
diálogos RPC sin operador y termina únicamente sus propios hijos al cerrar.
El historial operativo, sin prompts, se guarda en
`~/.pi/agent/coordinator/history.jsonl`.

## Runtime y límites

Los recursos privados se crean en `$XDG_RUNTIME_DIR/pi-session-network/` o en
`/tmp/pi-session-network-<uid>/`. Un cierre normal elimina socket y registro.
El recolector usa un lock por runtime y sólo borra entradas con heartbeat de
más de 60 segundos, PID inexistente y probe fallido.

Sólo se descubren procesos del mismo usuario y namespace de runtime. No hay
TCP, soporte macOS/Windows, broadcast, shell remoto ni garantía de entrega
exactly-once después de un crash.

## Pruebas

```bash
npm test
npm run test:pi-session-network-real
```

La segunda prueba requiere `tmux` y ejecuta Pi real para `/reload`, `/new`,
`/resume`, `/fork`, `SIGTERM` y `SIGKILL`.
