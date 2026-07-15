import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), "superflag-core-package-"));
const cache = join(temp, ".npm-cache");
const fixture = join(temp, "consumer");
const entrypoints = [
  "@superflag-sh/core",
  "@superflag-sh/core/react",
  "@superflag-sh/core/react-native",
  "@superflag-sh/core/node",
  "@superflag-sh/core/cli",
  "@superflag-sh/core/openfeature",
  "@superflag-sh/core/legacy",
  "@superflag-sh/core/conformance",
  "@superflag-sh/core/events",
  "@superflag-sh/core/experiments",
  "@superflag-sh/core/inspection",
  "@superflag-sh/core/telemetry",
];

function run(command, args, cwd = root) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      env: { ...process.env, CI: "1", NODE_PATH: "", npm_config_cache: cache },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    const stdout = error.stdout?.toString().trim();
    const stderr = error.stderr?.toString().trim();
    throw new Error(
      [command + " " + args.join(" ") + " failed", stdout, stderr]
        .filter(Boolean)
        .join("\n"),
      { cause: error },
    );
  }
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

try {
  mkdirSync(fixture);
  const packed = JSON.parse(
    run("npm", [
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      temp,
    ]),
  )[0];
  const tarball = join(temp, packed.filename);
  const entries = run("tar", ["-tzf", tarball], temp).trim().split("\n");
  const leaked = entries.filter((entry) =>
    /(?:^|\/)(?:src|scripts|test|tests|__tests__)(?:\/|$)/.test(entry),
  );
  if (leaked.length > 0)
    throw new Error(
      "Packed artifact leaked source-only files: " + leaked.join(", "),
    );

  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({
      name: "superflag-core-packed-consumer",
      version: "1.0.0",
      private: true,
      type: "module",
      dependencies: {
        "@superflag-sh/core": "file:" + tarball,
        typescript: "5.9.3",
      },
    }),
  );
  run(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
    ],
    fixture,
  );

  const installedRoot = realpathSync(
    join(fixture, "node_modules", "@superflag-sh", "core"),
  );
  if (!installedRoot.startsWith(realpathSync(fixture)))
    throw new Error("Packed core resolved outside the consumer fixture");
  const manifest = JSON.parse(
    readFileSync(join(installedRoot, "package.json"), "utf8"),
  );
  const exportTargets = new Set(
    [
      manifest.main,
      manifest.types,
      ...Object.values(manifest.exports).flatMap((value) =>
        typeof value === "string" ? [value] : Object.values(value),
      ),
    ].filter(
      (value) => typeof value === "string" && value !== "./package.json",
    ),
  );
  for (const target of exportTargets) {
    const entry = "package/" + target.replace(/^\.\//, "");
    if (!entries.includes(entry))
      throw new Error("Packed artifact is missing export target: " + target);
  }

  const imports = entrypoints
    .map(
      (entrypoint, index) =>
        "import * as entry" + index + ' from "' + entrypoint + '";',
    )
    .join("\n");
  const usages = entrypoints.map((_, index) => "entry" + index).join(", ");
  const conformanceEntry =
    "entry" + entrypoints.indexOf("@superflag-sh/core/conformance");
  writeFileSync(
    join(fixture, "consumer.ts"),
    imports + "\nexport const entries = [" + usages + "];\n",
  );
  writeFileSync(
    join(fixture, "smoke.mjs"),
    imports +
      "\nconst entries = [" +
      usages +
      '];\nif (entries.some((entry) => Object.keys(entry).length === 0)) throw new Error("Runtime subpath export missing");\n' +
      "const experimentResults = " +
      conformanceEntry +
      '.runExperimentAssignmentConformanceVectors();\nif (!experimentResults.every((result) => result.pass)) throw new Error("Packed experiment conformance failed: " + JSON.stringify(experimentResults));\n',
  );
  writeFileSync(
    join(fixture, "tsconfig.nodenext.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
      include: ["consumer.ts"],
    }),
  );
  writeFileSync(
    join(fixture, "tsconfig.bundler.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
      },
      include: ["consumer.ts"],
    }),
  );
  writeFileSync(
    join(fixture, "tsconfig.no-dom.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        target: "ES2022",
        lib: ["ES2022"],
        types: [],
        module: "ESNext",
        moduleResolution: "Bundler",
      },
      include: ["consumer.ts"],
    }),
  );

  run("node", ["smoke.mjs"], fixture);
  run(
    join(fixture, "node_modules", ".bin", "tsc"),
    ["-p", "tsconfig.nodenext.json"],
    fixture,
  );
  run(
    join(fixture, "node_modules", ".bin", "tsc"),
    ["-p", "tsconfig.bundler.json"],
    fixture,
  );
  run(
    join(fixture, "node_modules", ".bin", "tsc"),
    ["-p", "tsconfig.no-dom.json"],
    fixture,
  );

  const declarations = filesUnder(join(installedRoot, "dist")).filter((path) =>
    path.endsWith(".d.ts"),
  );
  for (const declaration of declarations) {
    const source = readFileSync(declaration, "utf8");
    if (/from ["']\.\/(?!.*\.js["'])/.test(source)) {
      throw new Error(
        "NodeNext-incompatible declaration import: " + declaration,
      );
    }
  }

  console.log(
    "packed artifact: " +
      manifest.name +
      "@" +
      manifest.version +
      ", " +
      entries.length +
      " files, source-only entries: 0",
  );
  console.log("runtime exports: " + entrypoints.length + " ESM entrypoints ok");
  console.log(
    "declarations: " +
      declarations.length +
      " files, NodeNext, Bundler, and no-DOM consumers ok without skipLibCheck",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
