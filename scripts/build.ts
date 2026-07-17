const entrypoints = [
  "index",
  "react",
  "react-native",
  "node",
  "cli",
  "openfeature",
  "legacy",
  "conformance",
  "events",
  "experiments",
  "inspection",
  "telemetry",
  "cache",
] as const;

export {};

for (const entrypoint of entrypoints) {
  const result = await Bun.build({
    entrypoints: [`src/${entrypoint}.ts`],
    outdir: "dist",
    naming: `${entrypoint}.js`,
    target: "browser",
    format: "esm",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
}
