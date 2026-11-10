import { spawn } from 'node:child_process'
import ffmpegPath from 'ffmpeg-static'

// Hashes, crops and enhanced images share the bot container's memory budget.
let previous = Promise.resolve()

export function runFfmpeg(input, filters, options = {}) {
  const operation = previous.then(() => processImage(input, filters, options))
  previous = operation.catch(() => undefined)
  return operation
}

function processImage(input, filters, options) {
  const executable = options.ffmpegPath ?? ffmpegPath
  if (!executable) throw new Error('ffmpeg-static did not provide an image-processing executable.')
  const timeoutMs = options.timeoutMs ?? 30_000

  return new Promise((resolve, reject) => {
    const child = spawn(
      executable,
      [
        '-hide_banner', '-loglevel', 'error', '-filter_threads', '1',
        '-threads', '1', '-i', 'pipe:0', '-frames:v', '1', ...filters,
        '-threads', '1', 'pipe:1',
      ],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] },
    )
    const output = []
    const errors = []
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    timer.unref()

    child.stdout.on('data', (chunk) => output.push(chunk))
    child.stderr.on('data', (chunk) => errors.push(chunk))
    child.on('error', (reason) => {
      clearTimeout(timer)
      reject(reason)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (timedOut) {
        reject(new Error('Screenshot image processing timed out.'))
        return
      }
      if (code !== 0) {
        const detail = Buffer.concat(errors)
          .toString('utf8')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 400)
        reject(new Error(`Screenshot image processing failed${detail ? `: ${detail}` : ` with code ${code}`}.`))
        return
      }
      resolve(Buffer.concat(output))
    })
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}
