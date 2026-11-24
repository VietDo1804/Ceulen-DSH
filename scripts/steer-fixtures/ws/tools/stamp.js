// Prints a stamp derived from --seed, so the answer cannot be guessed from the runbook text.
const at = process.argv.indexOf('--seed')
const seed = Number(at === -1 ? 0 : process.argv[at + 1])
console.log(`steer-fixture-${seed * 6}`)
