# Instruction Inspector

Infografía técnica: [`examples/instruction-inspector-infographic/index.html`](../../examples/instruction-inspector-infographic/index.html).

Muestra la procedencia del instruction prompt sin enviar ese inventario al
modelo. Usa `/instructions` para paths relativos, `/instructions full` para
paths absolutos y `/instructions watch` para alternar el widget.

Distingue archivos de system/append prompt, context files (`AGENTS.md`), skills
anunciadas al modelo y skills cuyo archivo fue leído durante la sesión. Pi sólo
incluye metadata de las skills descubiertas en el system prompt; el contenido
de `SKILL.md` entra al contexto cuando el agente lo lee.

El inventario mide su latencia local con `performance.now()` y muestra última,
promedio, máxima y cantidad de muestras. No registra tools ni mensajes, no
inyecta el inventario en el system prompt y no realiza requests adicionales al
provider: agrega cero tokens y costo directo de provider igual a cero.

El orchestrator la carga automáticamente en workers y expone el prompt del rol
mediante `PI_ORCHESTRATOR_ROLE_PROMPT_PATH`. También puede cargarse como una
extensión normal en la sesión principal.

## Limpieza on the fly

El hook existente `before_agent_start` compacta system/append prompts y context
files Markdown antes del turno, sin cambiar los archivos originales. Quita los
numerales de encabezados y sustituye saltos de línea de prosa por espacios.

El hook `before_provider_request` del mismo módulo limpia también las instrucciones
ya ensambladas: wrappers XML, skills anunciadas y avisos agregados posteriormente.

Preserva bloques de código, escapes literales `\\n`, hashes internos y mensajes
user/assistant y resultados de tools. Los handlers del provider se ejecutan en
orden de carga; un handler posterior que reemplace instrucciones puede
reintroducir formato. Cargar inspector antes de `provider-gate` permite ver el
texto compactado en su UI. El ahorro de tokens depende del tokenizer.
