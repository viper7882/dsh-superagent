/**
 * Run SCVD's Cursor Agent SDK worker from Super Agent (replaces DeepSeek llm workers).
 * Requires CURSOR_API_KEY and SCVD_REPO (smart-contract-vul-detector root) in the process env.
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

export type CursorSdkResult = {
  ok: boolean
  status?: string
  result?: string
  error?: string
  raw?: unknown
}

function env(name: string): string {
  return String(process.env[name] ?? '').trim()
}

export function cursorSdkConfigured(): { ok: true; repo: string; python: string; key: string } | { ok: false; error: string } {
  const key = env('CURSOR_API_KEY')
  const repo = env('SCVD_REPO') || env('CURSOR_SCVD_ROOT')
  const python = env('SCVD_PYTHON') || env('PYTHON') || 'python'
  if (!key) return { ok: false, error: 'CURSOR_API_KEY is not set in the DSH process environment' }
  if (!repo) return { ok: false, error: 'SCVD_REPO is not set (path to smart-contract-vul-detector)' }
  return { ok: true, repo, python, key }
}

/**
 * Spawn `python -m scvd.cursor_worker` and return its JSON result.
 * Long-running; caller should report progress on the ticket first.
 */
export function runCursorSdkWorker(input: {
  task: string
  ticketId: string
  model?: string
  timeoutMs?: number
}): Promise<CursorSdkResult> {
  const cfg = cursorSdkConfigured()
  if (!cfg.ok) return Promise.resolve({ ok: false, error: cfg.error })

  const model = input.model || env('CURSOR_WORKER_MODEL') || 'composer-2.5'
  const timeoutMs = input.timeoutMs ?? 15 * 60_000
  const args = ['-m', 'scvd.cursor_worker', '--task', input.task, '--ticket-id', input.ticketId, '--model', model]
  const childEnv = {
    ...process.env,
    CURSOR_API_KEY: cfg.key,
    PYTHONPATH: [join(cfg.repo, 'src'), process.env.PYTHONPATH ?? ''].filter(Boolean).join(process.platform === 'win32' ? ';' : ':'),
    PYTHONUTF8: '1',
  }

  return new Promise(resolve => {
    const child = spawn(cfg.python, args, {
      cwd: cfg.repo,
      env: childEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      resolve({ ok: false, error: `Cursor SDK worker timed out after ${timeoutMs}ms`, result: stdout.slice(-2000), raw: { stderr: stderr.slice(-2000) } })
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer | string) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk: Buffer | string) => { stderr += String(chunk) })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, error: String(error), raw: { stderr } })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      const text = stdout.trim() || stderr.trim()
      try {
        const jsonStart = text.lastIndexOf('{')
        const parsed = jsonStart >= 0 ? JSON.parse(text.slice(jsonStart)) as CursorSdkResult : null
        if (parsed && typeof parsed === 'object') {
          resolve({
            ok: Boolean(parsed.ok),
            status: parsed.status,
            result: parsed.result,
            error: parsed.error || (parsed.ok ? undefined : `cursor_worker exit ${code}`),
            raw: parsed,
          })
          return
        }
      } catch { /* fall through */ }
      resolve({
        ok: code === 0,
        error: code === 0 ? undefined : `cursor_worker exit ${code}: ${stderr.slice(-500) || text.slice(-500)}`,
        result: text.slice(-8000),
      })
    })
  })
}
