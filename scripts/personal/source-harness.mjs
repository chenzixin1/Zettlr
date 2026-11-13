import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import EventEmitter from 'node:events'
import { fileURLToPath } from 'node:url'
import * as ts from 'typescript'
import { ChangeSet, Text } from '@codemirror/state'

export const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const documentsPath = 'source/app/service-providers/documents/index.ts'

// Compile the production module itself. Only import declarations are removed;
// Electron and filesystem service boundaries are injected below. No document
// synchronization method or watcher callback is copied into this test suite.
export function loadSource (relative, dependencies = {}) {
  const filename = path.join(repository, relative)
  let source = fs.readFileSync(filename, 'utf8')
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true)
  const imports = parsed.statements.filter(ts.isImportDeclaration)
  for (const statement of imports.reverse()) {
    source = source.slice(0, statement.getStart(parsed)) + source.slice(statement.getEnd())
  }
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: filename,
    reportDiagnostics: true
  })
  const errors = compiled.diagnostics?.filter(d => d.category === ts.DiagnosticCategory.Error) ?? []
  if (errors.length > 0) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCurrentDirectory: () => repository,
    getCanonicalFileName: x => x,
    getNewLine: () => '\n'
  }))
  const exports = {}
  new Function('exports', ...Object.keys(dependencies), compiled.outputText)(exports, ...Object.values(dependencies))
  return exports
}

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

export async function waitFor (condition, message, timeout = 4000) {
  const deadline = Date.now() + timeout
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${message}`)
    await delay(20)
  }
}

class ManualWatchdog {
  constructor () { this.callbacks = [] }
  on (_channel, callback) { this.callbacks.push(callback) }
  emit (event, file) { for (const callback of this.callbacks) callback(event, file) }
  watchPath () {}
  unwatchPath () {}
  getWatched () { return {} }
  async shutdown () {}
}

class MemoryContainer {
  constructor () { this.value = {} }
  get () { return this.value }
  set (value) { this.value = value }
  shutdown () {}
}

export async function createHarness (t, options = {}) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'zettlr-sync-test-'))
  const records = { events: [], logs: [], prompts: [], errors: [], reads: 0 }
  const electronApp = new EventEmitter()
  electronApp.getPath = () => directory
  electronApp.quit = () => {}
  const config = {
    alwaysReloadFiles: options.alwaysReloadFiles ?? true,
    appLang: 'en-US',
    editor: { autoSave: 'off' }
  }
  const logger = Object.fromEntries(['info', 'warning', 'verbose', 'error'].map(level => [level, (...args) => {
    records.logs.push({ level, args })
    if (level === 'error') records.errors.push(...args)
  }]))
  const { DP_EVENTS, DocumentType } = loadSource('source/types/common/documents.ts')
  const { getDocumentTypeForExtension } = loadSource('source/common/util/file-extention-checks.ts', { DocumentType })
  const { default: ProviderContract } = loadSource('source/app/service-providers/provider-contract.ts')
  const watchdog = new ManualWatchdog()
  const fsal = {
    getWatchdog: () => watchdog,
    getFilesystemMetadata: async file => ({ modtime: (await fsp.stat(file)).mtimeMs }),
    loadAnySupportedFile: async file => {
      records.reads++
      if (options.beforeRead) await options.beforeRead(file)
      return fsp.readFile(file, 'utf8')
    },
    writeTextFile: async (file, content) => {
      if (options.beforeWrite) await options.beforeWrite(file, content)
      return fsp.writeFile(file, content)
    },
    getDescriptorFor: async file => ({
      path: file, dir: path.dirname(file), name: path.basename(file), type: 'code',
      modtime: (await fsp.stat(file)).mtimeMs
    })
  }
  fsal.getDescriptorForAnySupportedFile = file => fsal.getDescriptorFor(file)
  const dialog = {
    showMessageBox: async prompt => {
      records.prompts.push(prompt)
      return options.respond
        ? options.respond(prompt)
        : { response: 0, checkboxChecked: config.alwaysReloadFiles }
    },
    showErrorBox: (...args) => records.logs.push({ level: 'error-box', args })
  }
  const ipcHandlers = new Map()
  const { default: DocumentManager } = loadSource(documentsPath, {
    EventEmitter, path, FSConstants: fs.constants, ProviderContract,
    PersistentDataContainer: MemoryContainer,
    ipcMain: { handle: (name, handler) => ipcHandlers.set(name, handler) },
    app: electronApp, dialog, DP_EVENTS, DocumentType, ChangeSet, Text, getDocumentTypeForExtension,
    trans: value => value,
    markdownToAST: () => [], countAll: () => ({ words: 0, chars: 0 })
  })
  const manager = new DocumentManager({
    fsal, log: logger,
    config: {
      get: key => key === undefined ? config : key.split('.').reduce((object, part) => object?.[part], config),
      set: (key, value) => { config[key] = value }
    },
    stats: { updateCounts () {} },
    citeproc: { async synchronizeDatabases () {} }
  })
  // Observe the IPC boundary; notifyRemoteChange and all synchronization
  // decisions still run the real production methods.
  manager.broadcastEvent = (event, context) => records.events.push({
    event, context,
    ...(event === DP_EVENTS.FILE_REMOTELY_CHANGED ? { diskContent: fs.readFileSync(context.filePath, 'utf8') } : {})
  })

  async function createFile (name, content) {
    const file = path.join(directory, name)
    await fsp.writeFile(file, content)
    return file
  }
  t.after(async () => {
    await manager.shutdown()
    electronApp.removeAllListeners()
    await fsp.rm(directory, { recursive: true, force: true })
  })
  return {
    directory, records, manager, watchdog, electronApp, fsal, config, DP_EVENTS,
    createFile,
    authority: (command, payload) => ipcHandlers.get('documents-authority')(null, { command, payload }),
    provider: (command, payload) => ipcHandlers.get('documents-provider')(null, { command, payload }),
    reloads: () => records.events.filter(record => record.event === DP_EVENTS.FILE_REMOTELY_CHANGED)
  }
}

export async function atomicWrite (file, content) {
  const temporary = `${file}.sync-test-tmp`
  const handle = await fsp.open(temporary, 'w')
  try { await handle.writeFile(content); await handle.sync() } finally { await handle.close() }
  await fsp.rename(temporary, file)
}
