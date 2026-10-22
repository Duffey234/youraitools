#!/bin/sh
# Compile contracts/TVSim.sol and write src/simcode.js. Needs solc 0.8.26 (static binary on PATH or $SOLC).
set -e
cd "$(dirname "$0")/.."
SOLC=${SOLC:-solc}
$SOLC --optimize --via-ir --bin-runtime contracts/TVSim.sol -o contracts/out --overwrite >/dev/null
printf "// Runtime bytecode of contracts/TVSim.sol (solc 0.8.26 --optimize --via-ir --bin-runtime). Regenerate: sh tools/build-sim.sh\n// Only ever used inside eth_call state overrides; never deployed.\nexport const TVSIM_RUNTIME = '0x%s';\n" "$(cat contracts/out/TVSim.bin-runtime)" > src/simcode.js
echo "src/simcode.js: $(wc -c < contracts/out/TVSim.bin-runtime) hex chars"
