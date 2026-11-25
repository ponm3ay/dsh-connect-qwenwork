// Extract the packages this plugin resolves at runtime from the installed app.asar,
// so a local smoke test runs against the exact versions DSH ships.
import { openSync, readSync, closeSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ARCHIVE = 'D:\\deepseek harness\\resources\\app.asar'
const OUT = process.argv[2]
const WANTED = ['/dsh/node_modules/']

const fd = openSync(ARCHIVE, 'r')
const head = Buffer.alloc(16)
readSync(fd, head, 0, 16, 0)
const headerSize = head.readUInt32LE(12)
const header = Buffer.alloc(headerSize)
readSync(fd, header, 0, headerSize, 16)
const tree = JSON.parse(header.toString('utf8'))
const base = 8 + head.readUInt32LE(4)

function walk(node, prefix, out) {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const path = prefix + '/' + name
    if (value.files) walk(value, path, out)
    else out.push([path, value])
  }
}

const files = []
walk(tree, '', files)

let written = 0
for (const [path, entry] of files) {
  if (entry.unpacked) continue
  if (!WANTED.some((prefix) => path.startsWith(prefix))) continue
  const relative = path.replace(/^\/dsh\/node_modules\//, '')
  const target = join(OUT, relative)
  mkdirSync(dirname(target), { recursive: true })
  const buffer = Buffer.alloc(entry.size)
  readSync(fd, buffer, 0, entry.size, base + Number(entry.offset))
  writeFileSync(target, buffer)
  written++
}
closeSync(fd)
console.log('extracted', written, 'files to', OUT)
