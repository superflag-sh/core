# Superflag core SDK

This repository owns framework-neutral schema validation, deterministic evaluation,
privacy projection, OpenFeature adaptation, canonical feature events, experiment
assignment, inspection, conformance vectors, and shared telemetry contracts. In the
full workspace, read `../AGENTS.md`, `../docs/core-sdk.md`, and task-relevant shared
docs first.

## Ownership rules

- Put evaluation semantics in core, not React, React Native, the CLI, or transport.
- Keep core dependency-light and free of DOM, browser-storage, React, and React Native
  assumptions. Framework packages own transport, persistence, lifecycle, and hooks.
- Preserve deterministic hashing, explicit time inputs, provenance, fallback reasons,
  privacy projection, and canonical serialization.
- Version config schema, event schema, experiment contracts, and package releases
  independently. Do not overload one version to mean another.
- Keep client projection fail closed and never admit arbitrary telemetry properties or
  raw targeting identity into canonical events.
- Treat public exports and subpath declarations as compatibility surfaces. Update
  entrypoints, declarations, conformance vectors, and documentation together.

## Verification and release

Run focused tests while iterating, then:

```bash
bun run release:check
```

The release gate must prove tests, typecheck, lint, multi-entry build output, and a
clean packed-package consumer. Source tests alone do not prove exports or NodeNext
declarations. Publish core before dependent React/React Native/CLI versions, confirm
the exact version from the registry, and never use `file:` or `link:` dependencies as
release proof. Do not commit, push, publish, or tag without explicit approval.
