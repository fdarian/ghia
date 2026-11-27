import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["js/**/*.{ts,tsx}", "!js/**/__tests__/**", "!js/**/*.d.ts"],
	format: ["esm"],
	platform: "node",
	unbundle: true,
	dts: true,
	sourcemap: true,
	clean: true,
	// A free `require` has to survive to dist/, which the bundler rewrites: see the file.
	copy: [{ from: "js/dom/html/parse5{.web.js,.js,.d.ts}", to: "dist/dom/html" }],
	fixedExtension: false,
	outDir: "dist",
	tsconfig: "tsconfig.json",
	// `../index.js` is the napi loader beside the .node; bundling a copy into dist/ breaks its relative .node lookup.
	// `vitest` is a devDependency that `testing-setup.ts` imports; bundling it copies the pnpm store into dist/.
	external: ["@ghia/native", "vitest", /^\.\.\/index\.js$/],
});
