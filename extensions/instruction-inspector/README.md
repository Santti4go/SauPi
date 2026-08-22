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
modifica el system prompt y no realiza requests al provider: agrega cero tokens
y costo directo de provider igual a cero.

El orchestrator la carga automáticamente en workers y expone el prompt del rol
mediante `PI_ORCHESTRATOR_ROLE_PROMPT_PATH`. También puede cargarse como una
extensión normal en la sesión principal.
