# Provider Gate

`provider-gate` es una compuerta de autorización humana para las llamadas al
LLM. Intercepta el payload mediante `before_provider_request`, lo presenta en
una interfaz HTTP local y espera una decisión antes de entregarlo al provider.

## Comportamiento predeterminado

La compuerta está **activada por defecto** al iniciar cada sesión. Las requests
cuyo último elemento representa un mensaje humano quedan bloqueadas hasta
presionar `ACCEPT` o `REJECT` en la interfaz:

- `ACCEPT` libera el payload mostrado en `SENT`.
- `REJECT` aborta la llamada y descarta las modificaciones pendientes.
- Un JSON inválido mantiene la request pausada para poder corregirlo.

Las continuaciones cuyo último elemento es `function_call`,
`function_call_output`, `tool_call` o `tool_result` no requieren aprobación.
No obstante, reciben la proyección acumulada antes de enviarse, para no
reintroducir mensajes editados o eliminados.

Si el servidor de autorización no puede iniciarse, la extensión falla de forma
cerrada y aborta las requests que deberían ser aprobadas.

## Comandos

- `/provider-gate`: vuelve a abrir la interfaz de autorización de la sesión.
- `/gate-off`: desactiva la espera de aprobación durante la sesión y libera las
  requests pendientes. La proyección continúa aplicándose en segundo plano.
- `/gate-on`: reactiva la aprobación manual para las siguientes requests.

El estado de `/gate-on` y `/gate-off` sólo dura durante la sesión actual. Una
nueva sesión vuelve a comenzar con la compuerta activada.

## Inspección y edición

Cada request ofrece tres vistas:

- `SENT`: objeto efectivo que se libera al provider.
- `RAW PI`: payload reconstruido por Pi antes de aplicar la proyección.
- `USER`: último mensaje humano extraído de `input`, `messages` o `contents`.

La barra superior muestra la telemetría disponible en Pi para la rama actual:
uso estimado de contexto, ventana máxima, tokens de input/output/cache, coste
acumulado y modelo activo. Con autenticación OAuth el coste se identifica como
`subscription`; si el modelo no publica precios aparece como no disponible.

`PI CONTEXT` proviene de `ctx.getContextUsage()` y representa la conversación
canónica estimada por Pi. No incluye las reescrituras posteriores realizadas en
`before_provider_request`; `SENT` sigue siendo la fuente de verdad para auditar
el payload efectivo.

`EDIT` permite modificar el JSON completo. Las ediciones de elementos
existentes dentro del array de conversación se guardan en un ledger y vuelven a
aplicarse en las llamadas siguientes. Los cambios fuera de `input`, `messages`
o `contents`, como `temperature`, sólo afectan la request actual y se marcan
como `REQUEST-ONLY`.

## DROP LAST TURN

`DROP LAST TURN` elimina de la proyección la interacción completa
inmediatamente anterior al prompt humano actual. El prompt actual se conserva.
La operación incluye:

- el mensaje humano del turno anterior;
- la respuesta del assistant correspondiente;
- sus eventos de tools asociados, para evitar referencias huérfanas.

La eliminación es transaccional: se prepara sobre la request pendiente y sólo
se incorpora al ledger al presionar `ACCEPT`. `REJECT` la descarta. En la
request siguiente, `SENT` omite esos elementos aunque `RAW PI` todavía pueda
contenerlos.

Cambiar manualmente la longitud del array desde `EDIT` no crea una eliminación
persistente. Para borrar un turno debe utilizarse `DROP LAST TURN`.

## Persistencia y límites

El ledger se guarda como una entrada custom de Pi que no participa en el
contexto y se restaura al reabrir la misma rama. La sesión canónica de Pi sigue
siendo append-only; la extensión mantiene una proyección virtual de lo que se
envía al provider.

Una compactación o un cambio de provider puede reserializar el contexto y hacer
que una identidad anterior deje de coincidir. La comparación entre `RAW PI` y
`SENT` permite detectar ese caso.

La UI conserva hasta doce requests en memoria. La URL incluye un token aleatorio
por sesión y el servidor sólo escucha en `127.0.0.1`, pero los payloads pueden
contener prompts, resultados de tools, imágenes y secretos: no se debe compartir
la URL.

## Opciones

```bash
pi --provider-gate-port 47831
pi --provider-gate-no-open
```

El puerto predeterminado es `0`, por lo que el sistema elige uno libre.
`--provider-gate-no-open` evita que la interfaz se abra automáticamente.
