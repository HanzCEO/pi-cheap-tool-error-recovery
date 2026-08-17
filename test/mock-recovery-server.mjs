// Minimal OpenAI-compatible mock for the recovery LLM, used by `npm run e2e`.
// It always returns the corrected `write` call so the live proof is deterministic.
import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 8799);

const corrected = JSON.stringify({
  // The assistant's intended call, expressed with the correct parameter name.
  // Normal content so the assistant accepts the result and stops looping; the
  // proof that *recovery* ran lives in the extension-written /tmp/e2e_proof.txt
  // log (the assistant cannot edit it), not in the final file contents.
  toolName: "write",
  args: { path: "abc.txt", content: "hello world" },
});

const body = JSON.stringify({
  choices: [{ message: { role: "assistant", content: corrected } }],
});

const server = http.createServer((req, res) => {
  let data = "";
  req.on("data", (c) => (data += c));
  req.on("end", () => {
    process.stdout.write("MOCK_RECOVERY received a request\n");
    res.setHeader("content-type", "application/json");
    res.end(body);
  });
});

server.listen(PORT, () => process.stdout.write(`mock recovery server on ${PORT}\n`));
