#!/usr/bin/env node
import { main } from "../src/runner.js"

const code = await main()
process.exitCode = typeof code === "number" ? code : 0
