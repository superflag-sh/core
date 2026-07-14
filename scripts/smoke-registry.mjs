import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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

const packageName = "@superflag-sh/core";
const registry = "https://registry.npmjs.org/";
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temp = mkdtempSync(join(tmpdir(), "superflag-core-registry-"));
const cache = join(temp, ".npm-cache");
const userConfig = join(temp, "npm-userconfig");
const globalConfig = join(temp, "npm-globalconfig");
const fixture = join(temp, "consumer");
const packedDirectory = join(temp, "packed");
const entrypoints = [
  "@superflag-sh/core",
  "@superflag-sh/core/react",
  "@superflag-sh/core/react-native",
  "@superflag-sh/core/node",
  "@superflag-sh/core/cli",
  "@superflag-sh/core/openfeature",
  "@superflag-sh/core/legacy",
  "@superflag-sh/core/conformance",
];
writeFileSync(userConfig, "");
writeFileSync(globalConfig, "");

function run(command, args, cwd = fixture) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "1",
        NODE_PATH: "",
        npm_config_cache: cache,
        npm_config_registry: registry,
        npm_config_userconfig: userConfig,
        npm_config_globalconfig: globalConfig,
      },
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

function npmJson(args, cwd = fixture) {
  return JSON.parse(
    run("npm", [...args, "--json", "--registry", registry], cwd),
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

async function registryMetadata(requestedVersion) {
  if (requestedVersion) {
    assert(
      /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requestedVersion),
      "SUPERFLAG_PACKAGE_VERSION must be exact",
    );
  }
  const attempts = requestedVersion ? 12 : 1;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const metadata = npmJson(
        ["view", packageName + "@" + (requestedVersion || "latest")],
        root,
      );
      if (requestedVersion && !metadata.dist?.attestations?.url)
        throw new Error("npm provenance is not available yet");
      return metadata;
    } catch (error) {
      if (attempt === attempts) throw error;
      console.log(
        "waiting for " +
          packageName +
          "@" +
          requestedVersion +
          " in npm (" +
          attempt +
          "/" +
          attempts +
          ")",
      );
      await new Promise((resolve) => setTimeout(resolve, 10_000));
    }
  }
}

try {
  mkdirSync(fixture);
  mkdirSync(packedDirectory);
  const requestedVersion = process.env.SUPERFLAG_PACKAGE_VERSION?.trim();
  const metadata = await registryMetadata(requestedVersion);
  const version = metadata.version;
  assert(typeof version === "string", "Registry package version is missing");
  assert(
    !requestedVersion || version === requestedVersion,
    "Registry resolved the wrong package version",
  );
  assert(
    metadata.dist?.integrity?.startsWith("sha512-"),
    "Registry package is missing SHA-512 integrity",
  );
  assert(
    metadata.dist?.tarball?.startsWith(registry + "@superflag-sh/core/-/"),
    "Registry package has an unexpected tarball URL",
  );
  assert(
    metadata.dist?.attestations?.provenance?.predicateType ===
      "https://slsa.dev/provenance/v1",
    "Registry package is missing SLSA provenance",
  );
  assert(
    metadata._npmUser?.trustedPublisher?.id === "github",
    "Registry package was not published by trusted GitHub OIDC",
  );
  assert(
    metadata.repository?.url === "git+https://github.com/superflag-sh/core.git",
    "Registry package has unexpected repository metadata",
  );

  const attestationResponse = await fetch(metadata.dist.attestations.url);
  assert(
    attestationResponse.ok,
    "npm attestation endpoint returned " + attestationResponse.status,
  );
  const attestations = (await attestationResponse.json()).attestations;
  const provenance = attestations?.find(
    (entry) => entry.predicateType === "https://slsa.dev/provenance/v1",
  );
  assert(
    provenance?.bundle?.mediaType?.startsWith(
      "application/vnd.dev.sigstore.bundle",
    ),
    "npm returned an unexpected provenance bundle",
  );
  const statement = JSON.parse(
    Buffer.from(provenance.bundle.dsseEnvelope.payload, "base64").toString(
      "utf8",
    ),
  );
  const subject = statement.subject?.find(
    (entry) => entry.name === "pkg:npm/%40superflag-sh/core@" + version,
  );
  const expectedSha512 = Buffer.from(
    metadata.dist.integrity.slice("sha512-".length),
    "base64",
  ).toString("hex");
  assert(
    subject?.digest?.sha512 === expectedSha512,
    "SLSA subject does not match the registry tarball",
  );
  const workflow =
    statement.predicate?.buildDefinition?.externalParameters?.workflow;
  assert(
    workflow?.repository === "https://github.com/superflag-sh/core",
    "SLSA provenance names the wrong repository",
  );
  assert(
    workflow?.path === ".github/workflows/publish.yml",
    "SLSA provenance names the wrong workflow",
  );
  assert(
    workflow?.ref === "refs/tags/v" + version,
    "SLSA provenance names the wrong release tag",
  );

  const packed = npmJson(
    [
      "pack",
      packageName + "@" + version,
      "--ignore-scripts",
      "--pack-destination",
      packedDirectory,
    ],
    temp,
  )[0];
  const tarball = join(packedDirectory, packed.filename);
  assert(
    packed.integrity === metadata.dist.integrity,
    "Packed artifact integrity differs from registry metadata",
  );
  const tarballIntegrity =
    "sha512-" +
    createHash("sha512").update(readFileSync(tarball)).digest("base64");
  assert(
    tarballIntegrity === metadata.dist.integrity,
    "Downloaded tarball bytes differ from registry integrity",
  );
  const entries = run("tar", ["-tzf", tarball], temp).trim().split("\n");
  const leaked = entries.filter((entry) =>
    /(?:^|\/)(?:src|scripts|test|tests|__tests__)(?:\/|$)/.test(entry),
  );
  assert(
    leaked.length === 0,
    "Registry artifact leaked source-only files: " + leaked.join(", "),
  );

  const exportTargets = new Set(
    [
      metadata.main,
      metadata.types,
      ...Object.values(metadata.exports).flatMap((value) =>
        typeof value === "string" ? [value] : Object.values(value),
      ),
    ].filter(
      (value) => typeof value === "string" && value !== "./package.json",
    ),
  );
  for (const target of exportTargets) {
    assert(
      entries.includes("package/" + target.replace(/^\.\//, "")),
      "Registry artifact is missing export target: " + target,
    );
  }

  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({
      name: "superflag-core-registry-consumer",
      version: "1.0.0",
      private: true,
      type: "module",
      dependencies: {
        [packageName]: version,
        typescript: "5.9.3",
      },
    }),
  );
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    fixture,
  );
  const lock = JSON.parse(
    readFileSync(join(fixture, "package-lock.json"), "utf8"),
  );
  assert(
    !/(?:file|link|workspace):/.test(JSON.stringify(lock)),
    "Registry consumer lock contains a local dependency protocol",
  );
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path || entry.link) continue;
    assert(
      entry.resolved?.startsWith(registry),
      "Non-registry lock resolution at " + path + ": " + entry.resolved,
    );
    assert(
      entry.integrity?.startsWith("sha512-"),
      "Missing lock integrity at " + path,
    );
  }
  const coreLock = lock.packages?.["node_modules/@superflag-sh/core"];
  assert(
    coreLock?.version === version,
    "Installed core version differs from the exact registry version",
  );
  assert(
    coreLock?.integrity === metadata.dist.integrity,
    "Installed core integrity differs from registry metadata",
  );
  const installedRoot = realpathSync(
    join(fixture, "node_modules", "@superflag-sh", "core"),
  );
  assert(
    installedRoot.startsWith(realpathSync(fixture)),
    "Registry core resolved outside the isolated fixture",
  );

  const imports = entrypoints
    .map(
      (entrypoint, index) =>
        "import * as entry" + index + ' from "' + entrypoint + '";',
    )
    .join("\n");
  const usages = entrypoints.map((_, index) => "entry" + index).join(", ");
  writeFileSync(
    join(fixture, "consumer.ts"),
    imports + "\nexport const entries = [" + usages + "];\n",
  );
  writeFileSync(
    join(fixture, "smoke.mjs"),
    imports +
      "\nconst entries = [" +
      usages +
      '];\nif (entries.some((entry) => Object.keys(entry).length === 0)) throw new Error("Runtime subpath export missing");\n',
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

  const declarations = filesUnder(join(installedRoot, "dist")).filter((path) =>
    path.endsWith(".d.ts"),
  );
  for (const declaration of declarations) {
    assert(
      !/from ["']\.\/(?!.*\.js["'])/.test(readFileSync(declaration, "utf8")),
      "NodeNext-incompatible declaration import: " + declaration,
    );
  }

  console.log("registry package: " + packageName + "@" + version);
  console.log(
    "artifact: " +
      entries.length +
      " files, SHA-512 integrity and trusted SLSA provenance verified",
  );
  console.log(
    "cold lockfile: registry-only resolution with integrity; no local protocols",
  );
  console.log(
    "consumer: " +
      entrypoints.length +
      " ESM entrypoints, NodeNext and Bundler declarations verified",
  );
} finally {
  rmSync(temp, { recursive: true, force: true });
}
