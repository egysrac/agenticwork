#!/usr/bin/env tsx
import { resolve } from 'node:path'
import { writeAgentMetrics } from '../src/metrics/agent-metrics.js'

function usage(): never {
  process.stderr.write('Usage: tsx scripts/aggregate-agent-metrics.ts --db <sqlite-path> [--output <jsonl-path>]\n')
  process.exit(2)
}

const args = process.argv.slice(2)
let databasePath: string | undefined
let outputPath = 'metrics/agent_metrics.jsonl'
const seen = new Set<string>()
for (let index = 0; index < args.length; index += 2) {
  const option = args[index]
  const value = args[index + 1]
  if (!value || value.startsWith('--') || seen.has(option)) usage()
  seen.add(option)
  if (option === '--db') databasePath = value
  else if (option === '--output') outputPath = value
  else usage()
}
if (!databasePath) usage()

try {
  const records = writeAgentMetrics(databasePath, outputPath)
  process.stdout.write(`wrote ${records} records to ${resolve(outputPath)}\n`)
} catch (error) {
  process.stderr.write(`agent metrics aggregation failed: ${(error as Error).message}\n`)
  process.exit(1)
}
