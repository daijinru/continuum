import { packager } from "@electron/packager";
import { execFileSync } from "node:child_process";
import { build } from "esbuild";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

if (
  process.platform !== "darwin" ||
  process.versions.node.split(".")[0] !== "24"
)
  throw Error("在目标架构的 Mac 上使用 Node 24 构建桌面端。");
const stage = await mkdtemp(join(tmpdir(), "continuum-package-"));
const ui = join(stage, "desktop"),
  service = join(stage, "workbench");
try {
  await mkdir(ui);
  await writeFile(
    join(ui, "package.json"),
    JSON.stringify({
      name: "continuum",
      productName: "Continuum",
      version: "0.1.0",
      main: "main.mjs",
    }),
  );
  await cp("apps/desktop/main.mjs", join(ui, "main.mjs"));
  await mkdir(join(service, "bin"), { recursive: true });
  await cp(process.execPath, join(service, "bin/node"));
  await cp("migrations", join(service, "migrations"), { recursive: true });
  await cp("apps/web/dist", join(service, "apps/web/dist"), {
    recursive: true,
  });
  await build({
    entryPoints: ["apps/api/src/main.ts"],
    outfile: join(service, "apps/api/src/main.mjs"),
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    banner: {
      js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
    },
  });
  const require = createRequire(import.meta.url);
  const { version } = JSON.parse(
    await readFile(require.resolve("electron/package.json"), "utf8"),
  );
  const iconset = join(stage, "Continuum.iconset");
  const icon = join(stage, "Continuum.icns");
  await mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) {
    for (const scale of [1, 2]) {
      const pixels = String(size * scale);
      const name = `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`;
      execFileSync("sips", [
        "-z",
        pixels,
        pixels,
        "apps/desktop/assets/continuum.png",
        "--out",
        join(iconset, name),
      ]);
    }
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", icon]);
  const [dir] = await packager({
    icon,
    dir: ui,
    out: resolve("apps/desktop/dist"),
    name: "Continuum",
    appBundleId: "dev.continuum.workbench",
    electronVersion: version,
    extraResource: [service],
    overwrite: true,
    prune: false,
    asar: true,
  });
  const bundle = join(dir, "Continuum.app");
  // Local Mac builds use an ad hoc identity; public distribution needs Developer ID.
  execFileSync("codesign", ["--force", "--deep", "--sign", "-", bundle]);
  execFileSync("codesign", ["--verify", "--deep", "--strict", bundle]);
  console.log(bundle);
} finally {
  await rm(stage, { recursive: true, force: true });
}
