import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = dirname(dirname(fileURLToPath(import.meta.resolve("unbash"))));
const target = new URL("../extensions/vendor/unbash/", import.meta.url);
const upstream = JSON.parse(await readFile(join(source, "package.json"), "utf8"));
const project = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (upstream.version !== project.devDependencies.unbash) {
  throw new Error("Install the pinned unbash version before refreshing the vendored parser.");
}
await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(join(source, "dist"), new URL("dist/", target), { recursive: true });
await cp(join(source, "LICENSE"), new URL("LICENSE", target));
await writeFile(new URL("package.json", target), `${JSON.stringify({
  name: upstream.name,
  version: upstream.version,
  type: upstream.type,
  license: upstream.license,
  repository: upstream.repository,
}, null, 2)}\n`);
