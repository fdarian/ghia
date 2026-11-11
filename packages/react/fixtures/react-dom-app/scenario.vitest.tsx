import { writeFileSync } from "node:fs"
import { test } from "vitest"
import { run } from "./scenario.tsx"

// Vitest holds the test's console back; the outer test reads the facts from this file.
test("react-dom", () => {
  writeFileSync("facts.txt", run().join("\n"))
})
