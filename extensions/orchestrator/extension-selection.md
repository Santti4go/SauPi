# Worker extension selection

These rules apply to `extensions` in `.pi/orchestrator.yaml` (and alternative
orchestrator configs), not Pi's package filters in `.pi/settings.json`.

## Append without replacing defaults

```yaml
defaults:
  extensions:
    - .pi/extensions/audit.ts

agents:
  - name: developer
    description: Implementation
    prompt: .pi/agents/developer.md
    extensions:
      - +.pi/extensions/pi-voice.ts
```

The worker loads `audit.ts` followed by `pi-voice.ts`. Use the actual extension
entrypoint paths in your project. Both persistent and ephemeral workers receive
the resolved list through explicit `--extension` arguments.

“Inherited” means `defaults.extensions`, not the extensions loaded in the parent
Pi session. Workers still use `--no-extensions` to prevent automatic discovery.

## Reset, then append

```yaml
extensions:
  - []
  - +.pi/extensions/ext1.ts
  - +.pi/extensions/ext2.ts
```

This removes all inherited/configured paths and selects only `ext1.ts` and
`ext2.ts`. `[]` is an actual empty YAML list, not the string `"[]"`.

Resets evaluate left to right. For example, `[+old.ts, [], +new.ts]` selects only
`new.ts`. A trailing reset selects no configurable extensions.

Resetting this list **does not disable mandatory extensions**: the role guard
and instruction inspector remain loaded, as do the runtime and theme extensions
required by persistent workers. Role and global protected-path policies still
apply.

## Compatibility and validation

- Omitted `extensions` inherits the defaults unchanged.
- `extensions: []` clears the configurable list, as before.
- A plain first path starts with an empty list, preserving legacy replacement.
- A `+path` first entry starts with the inherited list.
- Later path entries append (with or without `+`); `[]` clears at its position.
- Scalar paths are shorthand for a one-entry list; `+path` works as a scalar.
- `defaults.extensions` accepts the same syntax, with no inherited list.
- Paths resolve relative to the project root, including for worktree workers.
  Absolute paths are supported. Duplicate resolved paths load once, in order.
- Empty paths, bare `+`, non-string paths and non-empty nested lists are rejected
  with the configuration field in the error.

This syntax does not introduce globs, package discovery or per-path exclusions.
Changing configuration does not update an already-running worker's extensions;
restart the affected workers to apply the new list.
