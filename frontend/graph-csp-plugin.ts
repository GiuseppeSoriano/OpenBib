import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

/** Extract the two upstream bundled stylesheets instead of injecting inline style elements. */
export function graphCspPlugin(): Plugin {
  const virtualPrefix = "openbib-graph-css:";
  const sources = new Map<string, string>();
  return {
    name: "openbib-graph-csp",
    enforce: "pre",
    resolveId(id) { if (id.startsWith(virtualPrefix)) return "\0" + id + ".css"; },
    load(id) { if (id.startsWith("\0" + virtualPrefix)) return sources.get(id.slice(1, -4)); },
    transform(code, id) {
      if (!/\/(force-graph|float-tooltip)\/dist\/[^/]+\.mjs$/.test(id)) return null;
      const original = readFileSync(id, "utf8");
      const match = original.match(/var css_248z = ("(?:\\.|[^"\\])*");\s*styleInject\(css_248z\);/);
      if (!match || !code.includes("styleInject(css_248z);")) throw new Error("Graph stylesheet changed: review CSP extraction before upgrading");
      const key = virtualPrefix + id;
      sources.set(key, JSON.parse(match[1]) as string);
      return { code: 'import ' + JSON.stringify(key) + ';\n' + code.replace("styleInject(css_248z);", ""), map: null };
    },
  };
}
