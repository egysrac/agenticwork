#!/usr/bin/env tsx
import { resolve } from 'node:path'
import { writeHistoricalBaseline } from '../src/metrics/historical-baseline.js'

function usage(): never {
  process.stderr.write('Usage: tsx scripts/generate-historical-baseline.ts --db <sqlite-path> --start <UTC-ISO> --end <UTC-ISO> --output <json-path>\n')
  process.exit(2)
}

const values = new Map<string, string>()
const args = process.argv.slice(2)
for (let index = 0; index < args.length; index += 2) {
  const option = args[index]
  const value = args[index + 1]
  if (!['--db', '--start', '--end', '--output'].includes(option) || !value || value.startsWith('--') || values.has(option)) usage()
  values.set(option, value)
}
if (values.size !== 4) usage()

try {
  writeHistoricalBaseline(values.get('--db')!, values.get('--output')!, values.get('--start')!, values.get('--end')!)
  process.stdout.write(`wrote historical baseline to ${resolve(values.get('--output')!)}\n`)
} catch (error) {
  process.stderr.write(`historical baseline generation failed: ${(error as Error).message}\n`)
  process.exit(1)
}
