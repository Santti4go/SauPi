# Instruction strip

Compacta las instrucciones antes de cada turno mediante `before_agent_start`.
Se carga con el paquete y explícitamente en los workers persistentes y efímeros
(pese a `--no-extensions`). Los workers existentes necesitan reiniciarse.

- Procesa el system prompt personalizado, append prompt (incluido el rol del
  agente) y context files `.md`, como `AGENTS.md`.
- Quita marcadores de encabezados `#` a `######`, incluidos cierres opcionales.
- Sustituye saltos de línea reales por espacios y colapsa espacios de prosa.
- Preserva bloques de código cercados/indentados, hashes internos, links,
  escapes literales `\n`, listas, énfasis y demás sintaxis Markdown.
- No modifica archivos en disco, mensajes conversacionales, resultados de tools,
  metadatos de skills ni secciones generadas por Pi. No procesa archivos leídos
  con `read`: mantener su contenido exacto es importante para posteriores edits.

Usa opciones estructuradas en Pi moderno. En versiones anteriores reemplaza
sólo los textos de instrucciones dentro del prompt efectivo. Cargar después de
las extensiones que agreguen instrucciones para que también las compacte.

Esto reduce caracteres de prosa; el ahorro de tokens depende del tokenizer y no
se garantiza. Los saltos de línea dentro de código se conservan por seguridad.

Carga individual: `pi -e ./extensions/instruction-strip/index.ts`.
