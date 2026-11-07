import { build, dev } from "./index.js"
import { Effect, Option } from "effect"
import { CliError, Command, Flag } from "effect/cli"

const configFile = Flag.String("config").pipe(
  Flag.withAlias("c"),
  Flag.withDescription("Vite config file, relative to the working directory (default: vite.config.*)"),
  Flag.optional
)

const compile = Flag.Boolean("compile").pipe(
  Flag.withDescription("Compile the bundle into one executable with Bun and the native addon embedded; --no-compile skips it"),
  Flag.withDefault(true)
)

const requireBun = Effect.suspend(() =>
  process.versions.bun
    ? Effect.void
    : Effect.fail(
        new CliError.UserError({
          cause: new Error("ghia runs the app inside its own process with the native addon, so it needs Bun"),
        })
      )
)

const failAsUserError = (cause: unknown) => new CliError.UserError({ cause })

const devCommand = Command.make("dev", { config: configFile }, (input) =>
  Effect.scoped(
    Effect.gen(function* () {
      yield* requireBun
      yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => dev({ configFile: Option.getOrUndefined(input.config) }),
          catch: failAsUserError,
        }),
        (handle) => Effect.promise(() => handle.close())
      )
      // Runs until a signal interrupts the program, which closes the dev server on the way out.
      return yield* Effect.never
    })
  )
).pipe(Command.withDescription("Run the app with hot reload"))

const buildCommand = Command.make("build", { config: configFile, compile }, (input) =>
  Effect.gen(function* () {
    yield* requireBun
    yield* Effect.tryPromise({
      try: () => build({ configFile: Option.getOrUndefined(input.config), compile: input.compile }),
      catch: failAsUserError,
    })
  })
).pipe(Command.withDescription("Bundle the app into dist/ and compile it into one executable"))

export const ghia = Command.make("ghia").pipe(
  Command.withDescription("Develop and build Ghia apps"),
  Command.withSubcommands([devCommand, buildCommand])
)
