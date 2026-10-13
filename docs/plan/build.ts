import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

const DIR = import.meta.dir;

const out = process.argv[2] ?? join(DIR, "dist", "hindsight.html");

const preview = process.argv[3];

const result = await Bun.build({
  entrypoints: [join(DIR, "engine.ts")],
  target: "browser",
  format: "esm",
  minify: true,
});

if (!result.success) {
  console.error(result.logs.map((l) => l.message).join("\n"));
  process.exit(1);
}

const js = (await result.outputs[0]?.text()) ?? "";

const template = await Bun.file(join(DIR, "page.html")).text();

const MARKER = '<script type="module" src="./engine.ts"></script>';

if (!template.includes(MARKER)) {
  throw new Error(`page.html ne contient pas ${MARKER}`);
}

const page = template.replace(
  MARKER,
  `<script type="module">${js.replaceAll("</script", String.raw`<\/script`)}</script>`,
);

mkdirSync(dirname(out), { recursive: true });
await Bun.write(out, page);
console.log(`${out} (${(page.length / 1024).toFixed(0)} Ko)`);

if (preview !== undefined) {
  const doc = `<!doctype html>\n<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><style>:root{color-scheme:light;box-sizing:border-box}body{margin:0;padding:0;font:14px system-ui,sans-serif;background:#fff;color:#000}img{max-width:100%}[hidden]{display:none!important}</style></head><body>\n${page}\n</body></html>\n`;
  mkdirSync(dirname(preview), { recursive: true });
  await Bun.write(preview, doc);
  console.log(preview);
}
