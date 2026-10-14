// Shared helper for invoking the Claude Code CLI as the AI backend.
// Replaces the previous Sarvam AI HTTP integration used in aiHelper.js and sqlAgent.js.
const { spawn } = require('child_process');

const CLAUDE_MODEL = 'claude-sonnet-4-5';

/**
 * Run a single non-interactive Claude Code query and return the plain-text answer.
 * @param {string} prompt - Full prompt text (system + user content already combined)
 * @param {number} timeoutMs - Max time to wait before giving up
 * @returns {Promise<string>} - The assistant's text reply
 */
function askClaude(prompt, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const proc = spawn('claude', [
      '-p', prompt,
      '--output-format', 'json',
      '--model', CLAUDE_MODEL,
      '--max-turns', '1',
      '--dangerously-skip-permissions'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const text = parsed.result || parsed.content || '';
        resolve(String(text).trim());
      } catch (e) {
        // Fallback: treat raw stdout as the answer if JSON parsing fails
        resolve(stdout.trim());
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

module.exports = { askClaude };
