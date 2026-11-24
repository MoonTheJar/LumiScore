/**
 * Vite plugin: dev-server middleware for decoder detection API endpoints.
 *
 * Endpoints:
 *   HEAD /api/ffmpeg-check        -> check if system FFmpeg is installed
 *   HEAD /api/musescore-check     -> check if MuseScore is installed
 *   HEAD /api/ffmpeg-cloud-check  -> check if cloud FFmpeg is configured
 */
import { execSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Plugin } from 'vite'

function checkSystemFFmpeg(): boolean {
  try {
    execSync('ffmpeg -version', { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    return false
  }
}

function findMuseScorePath(): string | null {
  const commonPaths = [
    'C:\\Program Files\\MuseScore 4\\bin\\MuseScore4.exe',
    'C:\\Program Files (x86)\\MuseScore 4\\bin\\MuseScore4.exe',
    'C:\\Program Files\\MuseScore 3\\bin\\MuseScore3.exe',
    'C:\\Program Files (x86)\\MuseScore 3\\bin\\MuseScore3.exe',
  ]
  for (const p of commonPaths) {
    if (existsSync(p)) return p
  }
  // Try PATH
  try {
    execSync('musescore --version', { stdio: 'ignore', timeout: 5000 })
    return 'musescore'
  } catch {}
  try {
    execSync('musescore4 --version', { stdio: 'ignore', timeout: 5000 })
    return 'musescore4'
  } catch {}
  return null
}

function checkMuseScore(): boolean {
  // Check common installation paths on Windows
  const commonPaths = [
    'C:\\Program Files\\MuseScore 4\\bin\\MuseScore4.exe',
    'C:\\Program Files (x86)\\MuseScore 4\\bin\\MuseScore4.exe',
    'C:\\Program Files\\MuseScore 3\\bin\\MuseScore3.exe',
    'C:\\Program Files (x86)\\MuseScore 3\\bin\\MuseScore3.exe',
  ]
  
  for (const p of commonPaths) {
    if (existsSync(p)) return true
  }
  
  // Also try PATH
  try {
    execSync('musescore --version', { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    // not in PATH
  }
  
  try {
    execSync('musescore4 --version', { stdio: 'ignore', timeout: 5000 })
    return true
  } catch {
    // not in PATH
  }
  
  return false
}

export default function apiPlugin(): Plugin {
  return {
    name: 'vite-plugin-api',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        
        if (url === '/api/ffmpeg-check' && (req.method === 'HEAD' || req.method === 'GET')) {
          const available = checkSystemFFmpeg()
          res.statusCode = available ? 200 : 404
          res.setHeader('Content-Type', 'application/json')
          if (req.method === 'GET') {
            res.end(JSON.stringify({ available }))
          } else {
            res.end()
          }
          return
        }
        
        if (url === '/api/musescore-check' && (req.method === 'HEAD' || req.method === 'GET')) {
          const available = checkMuseScore()
          res.statusCode = available ? 200 : 404
          res.setHeader('Content-Type', 'application/json')
          if (req.method === 'GET') {
            res.end(JSON.stringify({ available }))
          } else {
            res.end()
          }
          return
        }
        
        if (url === '/api/ffmpeg-cloud-check' && (req.method === 'HEAD' || req.method === 'GET')) {
          // Cloud FFmpeg is not configured yet
          res.statusCode = 404
          res.setHeader('Content-Type', 'application/json')
          if (req.method === 'GET') {
            res.end(JSON.stringify({ available: false }))
          } else {
            res.end()
          }
          return
        }
        
        // MuseScore conversion endpoint: accepts POST with file body, returns MIDI
        if (url === '/api/musescore-convert' && req.method === 'POST') {
          const { tmpdir } = require('node:os')
          const { writeFileSync, readFileSync, unlinkSync } = require('node:fs')
          const { join } = require('node:path')
          const { randomUUID } = require('node:crypto')
          
          const msPath = findMuseScorePath()
          if (!msPath) {
            res.statusCode = 503
            res.setHeader('Content-Type', 'application/json')
            res.end(JSON.stringify({ error: 'MuseScore not installed' }))
            return
          }
          
          const chunks: Buffer[] = []
          req.on('data', (chunk: Buffer) => chunks.push(chunk))
          req.on('end', () => {
            const buf = Buffer.concat(chunks)
            const id = randomUUID()
            const inputPath = join(tmpdir(), `midee_${id}_input`)
            const outputPath = join(tmpdir(), `midee_${id}_output.mid`)
            
            // Determine input extension from query param
            const ext = (url.includes('?ext=') ? url.split('?ext=')[1] : '.mscz')
            const inputWithExt = inputPath + ext
            writeFileSync(inputPath + ext, buf)
            
            try {
              execSync(`"${msPath}" "${inputPath}${ext}" -o "${outputPath}"`, {
                stdio: 'ignore',
                timeout: 30000,
              })
              const midiData = readFileSync(outputPath)
              res.statusCode = 200
              res.setHeader('Content-Type', 'audio/midi')
              res.setHeader('Content-Length', midiData.length)
              res.end(midiData)
            } catch (err) {
              console.error('[MuseScore convert] failed:', err)
              res.statusCode = 500
              res.setHeader('Content-Type', 'application/json')
              res.end(JSON.stringify({ error: 'Conversion failed' }))
            } finally {
              try { unlinkSync(inputPath + ext) } catch {}
              try { unlinkSync(outputPath) } catch {}
            }
          })
          return
        }
        
        next()
      })
    },
  }
}