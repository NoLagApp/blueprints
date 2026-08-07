import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Guards the packaging bug that silently breaks React Native across every
 * blueprint SDK at once.
 *
 * Metro resolves package exports with the conditions ["react-native",
 * "import"/"require"]. It does NOT understand "browser". Without a
 * "react-native" condition, `import { NoLagChat } from '@nolag/chat'` on React
 * Native resolves to the Node build, which pulls the Node build of
 * @nolag/js-sdk, which imports `ws` and drags in net/tls/http. Metro then fails
 * to bundle.
 *
 * Older setups using legacy resolverMainFields pick up the top-level "browser"
 * field and work by accident, so this breaks for some users and not others.
 * These assertions need no React Native toolchain.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const jsDir = join(repoRoot, "js");

const packages = readdirSync(jsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory() && existsSync(join(jsDir, e.name, "package.json")))
  .map((e) => ({
    dir: join(jsDir, e.name),
    pkg: JSON.parse(readFileSync(join(jsDir, e.name, "package.json"), "utf8")),
  }));

/** Minimal conditional-exports resolver: first matching key in insertion order wins. */
function resolveExport(entry: unknown, conditions: string[]): string | null {
  if (typeof entry === "string") return entry;
  if (entry === null || typeof entry !== "object") return null;

  for (const [key, value] of Object.entries(entry as Record<string, unknown>)) {
    if (key === "default" || conditions.includes(key)) {
      const resolved = resolveExport(value, conditions);
      if (resolved !== null) return resolved;
    }
  }
  return null;
}

const METRO_CONDITIONS = ["react-native", "import"];
const BROWSER_CONDITIONS = ["browser", "import"];
const NODE_ESM_CONDITIONS = ["node", "import"];
const NODE_CJS_CONDITIONS = ["node", "require"];

it("finds all 12 blueprint SDK packages", () => {
  expect(packages.length).toBe(12);
});

describe.each(packages.map((p) => [p.pkg.name, p] as const))(
  "%s",
  (_name, { dir, pkg }) => {
    const root = pkg.exports["."];

    it("declares a react-native condition", () => {
      expect(Object.keys(root)).toContain("react-native");
    });

    it("orders react-native ahead of browser, import, require and default", () => {
      // Conditional exports match in key order, so a late react-native key
      // never gets a chance against import/require.
      const keys = Object.keys(root);
      const rn = keys.indexOf("react-native");
      for (const later of ["browser", "import", "require", "default"]) {
        const index = keys.indexOf(later);
        if (index !== -1) expect(rn).toBeLessThan(index);
      }
    });

    it("declares a top-level react-native field for legacy resolverMainFields", () => {
      expect(pkg["react-native"]).toBe("./dist/react-native.js");
    });

    it("resolves each consumer to its own build", () => {
      expect(resolveExport(root, METRO_CONDITIONS)).toBe("./dist/react-native.js");
      expect(resolveExport(root, BROWSER_CONDITIONS)).toBe("./dist/browser.js");
      expect(resolveExport(root, NODE_ESM_CONDITIONS)).toBe("./dist/index.mjs");
      expect(resolveExport(root, NODE_CJS_CONDITIONS)).toBe("./dist/index.cjs");
    });

    it("never resolves React Native to the Node build", () => {
      const resolved = resolveExport(root, METRO_CONDITIONS);
      expect(resolved).not.toBe("./dist/index.mjs");
      expect(resolved).not.toBe("./dist/index.cjs");
    });

    it("requires a core version that has the react-native condition", () => {
      // @nolag/js-sdk gained its own react-native condition in 1.12.0. A range
      // that still admits 1.11.x lets npm install a core the RN build cannot use.
      for (const field of ["peerDependencies", "devDependencies"] as const) {
        const range = pkg[field]?.["@nolag/js-sdk"];
        if (range) expect(range).toBe("^1.12.0");
      }
    });

    it("has a react-native source entry", () => {
      expect(existsSync(join(dir, "src/react-native.ts"))).toBe(true);
    });

    it("keeps @nolag/js-sdk out of dependencies so there is exactly one copy", () => {
      // NoLagSocket has private fields, so TypeScript compares it close to
      // nominally. Two copies of the core in the tree make passing a client
      // into a wrapper fail to typecheck with a useless error.
      expect(pkg.dependencies?.["@nolag/js-sdk"]).toBeUndefined();
      expect(pkg.peerDependencies?.["@nolag/js-sdk"]).toBeTruthy();
    });
  }
);

describe.each(
  packages
    .filter((p) => existsSync(join(p.dir, "dist/react-native.js")))
    .map((p) => [p.pkg.name, p] as const)
)("%s react-native build", (_name, { dir }) => {
  const source = readFileSync(join(dir, "dist/react-native.js"), "utf8");

  it("does not inline ws, wrtc or any Node core module", () => {
    // Metro collects dependencies statically and fails the bundle on anything
    // it cannot resolve, so these break the build, not just runtime.
    for (const pkg of ["ws", "net", "tls", "http", "wrtc"]) {
      for (const quoted of [`'${pkg}'`, `"${pkg}"`]) {
        expect(source.includes(`require(${quoted})`), `requires ${pkg}`).toBe(false);
        expect(source.includes(`from ${quoted}`), `imports ${pkg}`).toBe(false);
      }
    }
  });

  it("leaves @nolag/js-sdk external so Metro resolves it by condition", () => {
    expect(source).toMatch(/from ["']@nolag\/js-sdk["']/);
  });
});
