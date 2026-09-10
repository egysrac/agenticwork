#!/usr/bin/env tsx
import { writeTaskObservabilityMetrics } from '../src/metrics/task-observability.js'

const args = process.argv.slice(2)
const dbAt = args.indexOf('--db')
const outAt = args.indexOf('--output')
if (dbAt < 0 || outAt < 0 || !args[dbAt + 1] || !args[outAt + 1]) {
  process.stderr.write('Usage: tsx scripts/aggregate-task-observability.ts --db <sqlite-path> --output <json-path>\n')
  process.exit(2)
}
try { writeTaskObservabilityMetrics(args[dbAt + 1], args[outAt + 1]) }
catch (error) { process.stderr.write(`task observability aggregation failed: ${(error as Error).message}\n`); process.exit(1) }
