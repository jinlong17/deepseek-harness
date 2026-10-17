#!/usr/bin/env node
import { createLumxLaunchEnvironment } from './launch-environment.mjs'

const [mode, osHome, workspaceDirectory] = process.argv.slice(2)
if (mode === undefined || osHome === undefined || workspaceDirectory === undefined) {
  throw new Error('usage: node lumx/desktop/launch.mjs <consumer|developer> <os-home> <workspace>')
}

const launch = createLumxLaunchEnvironment({
  mode,
  osHome,
  workspaceDirectory,
  environment: process.env,
})
process.stdout.write(`${JSON.stringify(launch)}\n`)
