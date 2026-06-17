// claudopilot TypeScript engine entrypoint (stub).
// Phase-07 wires this up to package.json `bin`; until then bash remains the driver.

export function main(_argv: string[] = process.argv.slice(2)): number {
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
