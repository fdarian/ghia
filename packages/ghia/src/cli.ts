#!/usr/bin/env bun
import { BunRuntime, BunServices } from "@effect/platform-bun"
import { Effect, Runtime } from "effect"
import { Command } from "effect/cli"
import { createRequire } from "node:module"
import { ghia } from "./commands.js"

const packageJson = createRequire(import.meta.url)("../package.json") as { version: string }

Command.run(ghia, { version: packageJson.version }).pipe(
  Effect.provide(BunServices.layer),
  BunRuntime.runMain({
    // A signal that stops `ghia dev` is a normal way out, not the 130 of an interrupted program.
    teardown: (exit, onExit) => {
      Runtime.defaultTeardown(exit, (code) => onExit(code === 130 ? 0 : code))
    },
  })
)
