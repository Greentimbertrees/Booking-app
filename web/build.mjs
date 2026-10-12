// Builds the app into dist/ using the local esbuild and React.
// Uses esbuild from node_modules (npm install), or a shared copy if one is available.
const { build } = await import("esbuild").catch(() => import("/opt/npm-tools/node_modules/esbuild/lib/main.js"));
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";

const stamp = Date.now().toString(36);
rmSync("dist", { recursive: true, force: true });
mkdirSync("dist/assets", { recursive: true });

await build({
  entryPoints: ["src/main.jsx"],
  bundle: true,
  minify: true,
  format: "esm",
  target: ["es2020", "chrome100", "safari15"],
  jsx: "automatic",
  nodePaths: ["node_modules", "/opt/npm-tools/node_modules"],
  define: { "process.env.NODE_ENV": '"production"' },
  outfile: "dist/assets/app.js",
  logLevel: "warning",
});

cpSync("public", "dist", { recursive: true });
for (const f of ["index.html", "sw.js"]) {
  const src = f === "index.html" ? "index.html" : "dist/sw.js";
  writeFileSync(`dist/${f}`, readFileSync(src, "utf8").replaceAll("__BUILD__", stamp));
}
console.log("built", stamp, readdirSync("dist"), readdirSync("dist/assets"));
