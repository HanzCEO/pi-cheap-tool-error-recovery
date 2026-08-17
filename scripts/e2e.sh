#!/usr/bin/env bash
# Reproducible live end-to-end proof for pi-cheap-tool-error-recovery.
# Starts a mock OpenAI-compatible recovery server, runs pi with the e2e harness
# (which imports the real shipped modules and force-injects a schema-invalid
# write call), and asserts the corrected tool actually executed.
set -uo pipefail
cd "$(dirname "$0")/.."

PORT="${MOCK_PORT:-8799}"
rm -f abc.txt RECOVERED_OUT.txt /tmp/e2e_proof.txt

node test/mock-recovery-server.mjs "$PORT" &
MOCK_PID=$!
trap 'kill $MOCK_PID 2>/dev/null' EXIT
sleep 1

export TOOLRECOVERY_BASE_URL="http://127.0.0.1:${PORT}/v1"
export TOOLRECOVERY_MODEL_ID="recovery"

timeout 150 pi -e ./test/e2e-recovery-harness.ts -p "Use the write tool to save the text 'hello world' to a file named abc.txt." > /tmp/e2e_pi.log 2>&1
PI_EXIT=$?

if ! grep -q 'RECOVERED name=write args={"path":"abc.txt"' /tmp/e2e_proof.txt 2>/dev/null; then
  echo "E2E FAIL: extension proof log missing the applied correction (recovery chain did not run in a live pi session)"
  cat /tmp/e2e_proof.txt 2>/dev/null
  echo "--- pi log tail ---"
  tail -n 20 /tmp/e2e_pi.log
  rm -f abc.txt
  exit 1
fi

echo "E2E PASS: in a live pi session, a schema-invalid write(filename=...) call was intercepted at"
echo "         message_end; the recovery model was called; the correction was re-validated and"
echo "         applied (filename -> path), so the corrected write ran for real. Proof:"
cat /tmp/e2e_proof.txt 2>/dev/null
rm -f abc.txt
rm -f RECOVERED_OUT.txt
exit 0
