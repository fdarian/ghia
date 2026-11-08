/**
 * Compile the GPUIX chat example into a standalone Bun binary with `ghia build`.
 * On macOS also wraps it in a .app so Finder and Dock can show a custom icon.
 *
 * CI sets COMPILE_OUT, COMPILE_SKIP_ICONS, COMPILE_SKIP_APP. COMPILE_TARGET throws: ghia build
 * has no cross-compile option.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(fileURLToPath(import.meta.url))
const DIST = path.join(ROOT, 'dist')
const SVG = path.join(ROOT, 'assets', 'icons', 'openai-mark.svg')
const PNG = path.join(DIST, 'app-icon.png')
const ICO = path.join(DIST, 'app-icon.ico')
const ICNS = path.join(DIST, 'app-icon.icns')
const COMPILE_TARGET = process.env.COMPILE_TARGET
const WINDOWS =
  process.platform === 'win32' || (COMPILE_TARGET ?? '').includes('windows')
const BINARY = path.join(DIST, outputName())
const APP_NAME = 'GPUIX Chat'
const APP_BUNDLE = path.join(DIST, `${APP_NAME}.app`)

function outputName(): string {
  const requested = process.env.COMPILE_OUT
  if (requested) {
    return WINDOWS && !requested.endsWith('.exe') ? `${requested}.exe` : requested
  }
  return WINDOWS ? 'chat.exe' : 'chat'
}

function log(message: string): void {
  console.log(`[compile-chat] ${message}`)
}

function hasCommand(command: string): boolean {
  const result = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return result.status === 0
}

function run(command: string, args: string[], opts: { cwd?: string } = {}): void {
  log(`run: ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: opts.cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = result.stdout.trim()
  const stderr = result.stderr.trim()
  if (stdout && command !== 'sips') console.log(stdout)
  if (stderr && command !== 'sips') console.error(stderr)
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit ${result.status}`)
  }
}

async function buildIcons(): Promise<void> {
  if (process.env.COMPILE_SKIP_ICONS === '1') {
    log('skipping icons')
    return
  }
  if (!hasCommand('rsvg-convert') || !hasCommand('magick')) {
    log('rsvg-convert or magick missing, skipping icons')
    return
  }

  log(`building icons from ${path.relative(ROOT, SVG)}`)
  const svg = (await Bun.file(SVG).text()).replace(
    'fill="currentColor"',
    'fill="#ffffff"',
  )
  const whiteSvg = path.join(DIST, 'app-icon.svg')
  await Bun.write(whiteSvg, svg)

  run('rsvg-convert', [
    '-w',
    '1024',
    '-h',
    '1024',
    '--background-color',
    '#10a37f',
    whiteSvg,
    '-o',
    PNG,
  ])
  log(`wrote ${path.relative(ROOT, PNG)}`)

  run('magick', [PNG, '-define', 'icon:auto-resize=256,128,64,48,32,16', ICO])
  log(`wrote ${path.relative(ROOT, ICO)}`)

  if (process.platform !== 'darwin') return

  const iconset = path.join(DIST, 'app-icon.iconset')
  rmSync(iconset, { recursive: true, force: true })
  mkdirSync(iconset, { recursive: true })
  const sizes = [
    [16, 'icon_16x16.png'],
    [32, 'icon_16x16@2x.png'],
    [32, 'icon_32x32.png'],
    [64, 'icon_32x32@2x.png'],
    [128, 'icon_128x128.png'],
    [256, 'icon_128x128@2x.png'],
    [256, 'icon_256x256.png'],
    [512, 'icon_256x256@2x.png'],
    [512, 'icon_512x512.png'],
    [1024, 'icon_512x512@2x.png'],
  ] as const
  for (const [px, name] of sizes) {
    run('sips', ['-z', String(px), String(px), PNG, '--out', path.join(iconset, name)])
  }
  run('iconutil', ['-c', 'icns', iconset, '-o', ICNS])
  log(`wrote ${path.relative(ROOT, ICNS)}`)
}

function compileBinary(): void {
  if (COMPILE_TARGET) {
    throw new Error(
      `COMPILE_TARGET=${COMPILE_TARGET} is not supported: ghia build compiles for the host only`,
    )
  }
  log('running ghia build chat.main.tsx')
  const result = spawnSync(
    path.join(ROOT, 'node_modules', '.bin', 'ghia'),
    ['build', 'chat.main.tsx'],
    { cwd: ROOT, stdio: 'inherit' },
  )
  if (result.status !== 0) {
    throw new Error(`ghia build failed with exit ${result.status}`)
  }
  const built = path.join(DIST, WINDOWS ? 'app.exe' : 'app')
  if (built !== BINARY) renameSync(built, BINARY)
  log(`wrote ${path.relative(ROOT, BINARY)}`)
}

function wrapMacApp(): void {
  if (process.env.COMPILE_SKIP_APP === '1') return
  if (process.platform !== 'darwin') return
  if (COMPILE_TARGET && !COMPILE_TARGET.includes('darwin')) return

  log(`wrapping ${path.relative(ROOT, BINARY)} in ${path.basename(APP_BUNDLE)}`)
  rmSync(APP_BUNDLE, { recursive: true, force: true })
  const macos = path.join(APP_BUNDLE, 'Contents', 'MacOS')
  const resources = path.join(APP_BUNDLE, 'Contents', 'Resources')
  mkdirSync(macos, { recursive: true })
  mkdirSync(resources, { recursive: true })

  const executable = path.join(macos, 'chat')
  run('cp', [BINARY, executable])
  run('chmod', ['+x', executable])
  if (existsSync(ICNS)) {
    run('cp', [ICNS, path.join(resources, 'AppIcon.icns')])
  }

  const iconEntries = existsSync(ICNS)
    ? ['  <key>CFBundleIconFile</key>', '  <string>AppIcon</string>']
    : []
  const plist = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>CFBundleDevelopmentRegion</key>',
    '  <string>en</string>',
    '  <key>CFBundleDisplayName</key>',
    `  <string>${APP_NAME}</string>`,
    '  <key>CFBundleExecutable</key>',
    '  <string>chat</string>',
    ...iconEntries,
    '  <key>CFBundleIdentifier</key>',
    '  <string>dev.gpuix.chat</string>',
    '  <key>CFBundleInfoDictionaryVersion</key>',
    '  <string>6.0</string>',
    '  <key>CFBundleName</key>',
    `  <string>${APP_NAME}</string>`,
    '  <key>CFBundlePackageType</key>',
    '  <string>APPL</string>',
    '  <key>CFBundleShortVersionString</key>',
    '  <string>0.1.0</string>',
    '  <key>CFBundleVersion</key>',
    '  <string>1</string>',
    '  <key>LSMinimumSystemVersion</key>',
    '  <string>13.0</string>',
    '  <key>NSHighResolutionCapable</key>',
    '  <true/>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
  writeFileSync(path.join(APP_BUNDLE, 'Contents', 'Info.plist'), plist)
  run('touch', [APP_BUNDLE])
  log(`wrote ${path.relative(ROOT, APP_BUNDLE)}`)
}

async function main(): Promise<void> {
  log(`output dir ${path.relative(ROOT, DIST) || '.'}`)
  rmSync(DIST, { recursive: true, force: true })
  // ghia build empties dist/, so the icons are written after it.
  compileBinary()
  await buildIcons()
  wrapMacApp()
  log('done')
  if (process.platform === 'darwin' && existsSync(APP_BUNDLE)) {
    log(`run: open "${APP_BUNDLE}"`)
  } else {
    log(`run: ${BINARY}`)
  }
}

await main()
