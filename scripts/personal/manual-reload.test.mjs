import test from 'node:test'
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import { EditorState, Text } from '@codemirror/state'
import { collab, getSyncedVersion, sendableUpdates } from '@codemirror/collab'
import { createHarness, delay, waitFor, atomicWrite } from './source-harness.mjs'

async function openFixture (h, name = 'case.md', content = '# Original\n') {
  const file = await h.createFile(name, content)
  const opened = await h.authority('get-document', { filePath: file })
  return { file, opened }
}

async function insertThroughAuthority (h, file, insert) {
  const opened = await h.authority('get-document', { filePath: file })
  const state = EditorState.create({
    doc: opened.content,
    extensions: collab({ startVersion: opened.startVersion, clientID: 'manual-reload-regression' })
  }).update({ changes: { from: opened.content.length, insert } }).state
  const updates = sendableUpdates(state).map(update => ({
    changes: update.changes.toJSON(), clientID: update.clientID
  }))
  assert.equal(await h.authority('push-updates', {
    filePath: file, version: getSyncedVersion(state), updates
  }), true)
  return state.doc.toString()
}

const reload = (h, file) => h.provider('reload-file', { path: file })

test('clean manual reload replaces the cached authority and returns fresh disk content', async t => {
  const h = await createHarness(t)
  const { file } = await openFixture(h)
  const previous = h.manager.documents[0]
  await atomicWrite(file, '# Fresh disk\n\n## New heading\n')
  assert.equal(await reload(h, file), true)
  assert.equal(h.records.prompts.length, 0)
  assert.equal(h.reloads().length, 1)
  const results = await Promise.all(Array.from({ length: 3 }, () => h.authority('get-document', { filePath: file })))
  assert(results.every(result => result.content === '# Fresh disk\n\n## New heading\n' && result.startVersion === 0))
  assert.equal(h.manager.documents.length, 1)
  assert.notEqual(h.manager.documents[0], previous)
  assert.deepEqual(await h.provider('get-file-modification-status'), [])
})

for (const timestamp of ['same', 'older']) {
  test(`manual reload reads changed content with ${timestamp} mtime`, async t => {
    const h = await createHarness(t)
    const { file } = await openFixture(h, `mtime-${timestamp}.md`)
    const seconds = Math.floor(Date.now() / 1000) - 60
    await fsp.utimes(file, seconds, seconds)
    h.manager.documents[0].descriptor.modtime = (await fsp.stat(file)).mtimeMs
    await atomicWrite(file, '# Changed despite timestamp\n')
    await fsp.utimes(file, seconds, timestamp === 'same' ? seconds : seconds - 60)
    assert.equal((await fsp.stat(file)).mtimeMs, seconds * 1000 - (timestamp === 'same' ? 0 : 60000))
    assert.equal(await reload(h, file), true)
    assert.equal((await h.authority('get-document', { filePath: file })).content, '# Changed despite timestamp\n')
  })
}

test('dirty manual reload defaults to Cancel and preserves actual CodeMirror input', async t => {
  const h = await createHarness(t)
  const { file } = await openFixture(h)
  const edited = await insertThroughAuthority(h, file, '\nUNSAVED INPUT\n')
  await atomicWrite(file, '# External replacement\n')
  const readsBeforeCancel = h.records.reads
  assert.equal(await reload(h, file), false)
  assert.equal(h.records.prompts.length, 1)
  assert.equal(h.records.prompts[0].defaultId, 0)
  assert.equal(h.records.prompts[0].cancelId, 0)
  assert.equal(h.records.prompts[0].buttons[0], 'Cancel')
  assert.equal(h.reloads().length, 0)
  assert.equal(h.records.reads, readsBeforeCancel, 'Cancel must not load disk contents')
  const retained = await h.authority('get-document', { filePath: file })
  assert.equal(retained.content, edited)
  assert.equal(retained.startVersion, 1)
  assert.deepEqual(await h.provider('get-file-modification-status'), [file])
  assert.equal(await fsp.readFile(file, 'utf8'), '# External replacement\n')
})

test('dirty content is replaced only after explicit Load confirmation', async t => {
  const h = await createHarness(t, { respond: async () => ({ response: 1, checkboxChecked: false }) })
  const { file } = await openFixture(h)
  await insertThroughAuthority(h, file, '\nUNSAVED INPUT\n')
  await atomicWrite(file, '# Explicitly loaded disk\n')
  assert.equal(await reload(h, file), true)
  assert.equal(h.records.prompts.length, 1)
  assert.equal(h.reloads().length, 1)
  const fresh = await h.authority('get-document', { filePath: file })
  assert.equal(fresh.content, '# Explicitly loaded disk\n')
  assert.equal(fresh.startVersion, 0)
  assert.deepEqual(await h.provider('get-file-modification-status'), [])
})

test('Load reads the latest disk contents after confirmation instead of an earlier snapshot', async t => {
  let releaseDialog
  const gate = new Promise(resolve => { releaseDialog = resolve })
  const h = await createHarness(t, { respond: async () => {
    await gate
    return { response: 1, checkboxChecked: true }
  } })
  const { file } = await openFixture(h)
  await insertThroughAuthority(h, file, '\nUNSAVED INPUT\n')
  await atomicWrite(file, '# Disk B before confirmation\n')
  const pending = reload(h, file)
  await waitFor(() => h.records.prompts.length === 1, 'confirmation before latest disk read')
  await atomicWrite(file, '# Disk C written while confirming\n')
  releaseDialog()
  assert.equal(await pending, true)
  assert.equal(h.reloads().length, 1)
  assert.equal((await h.authority('get-document', { filePath: file })).content, '# Disk C written while confirming\n')
})

test('typing while the disk read is pending cancels reload without discarding input', async t => {
  let block = false
  let reading = false
  let releaseRead
  const gate = new Promise(resolve => { releaseRead = resolve })
  const h = await createHarness(t, { beforeRead: async () => {
    if (block) { block = false; reading = true; await gate }
  } })
  const { file } = await openFixture(h)
  await atomicWrite(file, '# External replacement\n')
  block = true
  const pending = reload(h, file)
  await waitFor(() => reading, 'manual reload started reading')
  const edited = await insertThroughAuthority(h, file, '\nTYPED DURING READ\n')
  releaseRead()
  assert.equal(await pending, false)
  assert.equal(h.reloads().length, 0)
  assert.equal((await h.authority('get-document', { filePath: file })).content, edited)
})

test('typing while a Load dialog is open cancels that stale answer', async t => {
  let releaseDialog
  const gate = new Promise(resolve => { releaseDialog = resolve })
  const h = await createHarness(t, { respond: async () => {
    await gate
    return { response: 1, checkboxChecked: true }
  } })
  const { file } = await openFixture(h)
  await insertThroughAuthority(h, file, '\nFIRST UNSAVED INPUT\n')
  await atomicWrite(file, '# External replacement\n')
  const pending = reload(h, file)
  await waitFor(() => h.records.prompts.length === 1, 'manual reload confirmation shown')
  const edited = await insertThroughAuthority(h, file, '\nTYPED DURING DIALOG\n')
  releaseDialog()
  assert.equal(await pending, false)
  assert.equal(h.records.prompts.length, 1)
  assert.equal(h.reloads().length, 0)
  assert.equal((await h.authority('get-document', { filePath: file })).content, edited)
})

test('saving during the disk read cancels reload even if the saved content and version are unchanged', async t => {
  let block = false
  let reading = false
  let releaseRead
  const gate = new Promise(resolve => { releaseRead = resolve })
  const h = await createHarness(t, { beforeRead: async () => {
    if (block) { block = false; reading = true; await gate }
  } })
  const { file, opened } = await openFixture(h)
  const previous = h.manager.documents[0]
  await atomicWrite(file, '# External replacement\n')
  block = true
  const pending = reload(h, file)
  await waitFor(() => reading, 'reload read before a save')
  assert.equal(await h.manager.saveFile(file), true)
  releaseRead()
  assert.equal(await pending, false)
  assert.equal(h.reloads().length, 0)
  assert.equal(h.manager.documents[0], previous)
  assert.equal((await h.authority('get-document', { filePath: file })).content, opened.content)
})

test('saving while confirmation is open cancels its stale Load answer', async t => {
  let releaseDialog
  const gate = new Promise(resolve => { releaseDialog = resolve })
  const h = await createHarness(t, { respond: async () => {
    await gate
    return { response: 1, checkboxChecked: true }
  } })
  const { file } = await openFixture(h)
  const edited = await insertThroughAuthority(h, file, '\nSAVED WHILE CONFIRMING\n')
  await atomicWrite(file, '# External replacement\n')
  const pending = reload(h, file)
  await waitFor(() => h.records.prompts.length === 1, 'confirmation before a save')
  assert.equal(await h.manager.saveFile(file), true)
  releaseDialog()
  assert.equal(await pending, false)
  assert.equal(h.reloads().length, 0)
  assert.equal((await h.authority('get-document', { filePath: file })).content, edited)
  assert.deepEqual(await h.provider('get-file-modification-status'), [])
})

test('a failed save remains dirty and manual reload still requires confirmation', async t => {
  const h = await createHarness(t, { beforeWrite: async () => { throw new Error('simulated write failure') } })
  const { file, opened } = await openFixture(h)
  const edited = await insertThroughAuthority(h, file, '\nUNSAVED AFTER FAILED SAVE\n')
  await assert.rejects(h.manager.saveFile(file), /simulated write failure/)
  const doc = h.manager.documents.find(document => document.filePath === file)
  assert.equal(doc.lastSavedContent, opened.content)
  assert.equal(doc.lastSavedVersion, 0)
  assert.equal(doc.currentVersion, 1)
  await atomicWrite(file, '# Disk after failed save\n')
  assert.equal(await reload(h, file), false)
  assert.equal(h.records.prompts.length, 1)
  assert.equal(h.records.prompts[0].defaultId, 0)
  assert.equal(h.reloads().length, 0)
  assert.equal((await h.authority('get-document', { filePath: file })).content, edited)
  assert.deepEqual(await h.provider('get-file-modification-status'), [file])
})

test('missing disk file leaves the cached editor document intact', async t => {
  const h = await createHarness(t)
  const { file, opened } = await openFixture(h)
  const previous = h.manager.documents[0]
  await fsp.unlink(file)
  assert.equal(await reload(h, file), false)
  assert.equal(h.reloads().length, 0)
  assert.equal(h.manager.documents[0], previous)
  assert.equal((await h.authority('get-document', { filePath: file })).content, opened.content)
})

test('legacy duplicate authorities all require confirmation and are replaced by one fresh authority', async t => {
  let decision = 0
  const h = await createHarness(t, { respond: async () => ({ response: decision, checkboxChecked: true }) })
  const { file } = await openFixture(h, 'legacy.md')
  const { file: otherFile } = await openFixture(h, 'other.md', '# Unrelated\n')
  const other = h.manager.documents.find(doc => doc.filePath === otherFile)
  const first = h.manager.documents.find(doc => doc.filePath === file)
  let staleSaves = 0
  let unrelatedTimer = 0
  first.saveTimeout = setTimeout(() => { staleSaves++ }, 200)
  other.saveTimeout = setTimeout(() => { unrelatedTimer++ }, 200)
  // A legacy session can already contain duplicate authorities. Make only the
  // later one dirty so checking just the first matching document is unsafe.
  h.manager.documents.push({ ...first, descriptor: { ...first.descriptor },
    currentVersion: 1, document: Text.of(['legacy unsaved copy']), updates: [],
    saveTimeout: setTimeout(() => { staleSaves++ }, 200) })
  await atomicWrite(file, '# Fresh legacy replacement\n')
  assert.equal(await reload(h, file), false)
  assert.equal(h.records.prompts.length, 1)
  assert.equal(h.manager.documents.filter(doc => doc.filePath === file).length, 2)
  decision = 1
  assert.equal(await reload(h, file), true)
  const responses = await Promise.all(Array.from({ length: 3 }, () => h.authority('get-document', { filePath: file })))
  assert(responses.every(response => response.content === '# Fresh legacy replacement\n' && response.startVersion === 0))
  assert.equal(h.manager.documents.filter(doc => doc.filePath === file).length, 1)
  assert.equal(h.manager.documents.find(doc => doc.filePath === otherFile), other)
  assert.equal(h.reloads().length, 1)
  await delay(250)
  assert.equal(staleSaves, 0, 'reload must cancel every replaced authority autosave timer')
  assert.equal(unrelatedTimer, 1, 'another document timer must remain untouched')
})

test('concurrent reload requests show a single confirmation and preserve unrelated documents', async t => {
  let releaseDialog
  const gate = new Promise(resolve => { releaseDialog = resolve })
  const h = await createHarness(t, { respond: async () => {
    await gate
    return { response: 1, checkboxChecked: true }
  } })
  const { file } = await openFixture(h, 'concurrent-reload.md')
  const { file: otherFile } = await openFixture(h, 'other.md', '# Unrelated\n')
  const other = h.manager.documents.find(doc => doc.filePath === otherFile)
  await insertThroughAuthority(h, file, '\nUNSAVED\n')
  await atomicWrite(file, '# Fresh concurrent replacement\n')
  const requests = Array.from({ length: 3 }, () => reload(h, file))
  await waitFor(() => h.records.prompts.length === 1, 'single shared reload confirmation')
  releaseDialog()
  const results = await Promise.all(requests)
  assert.equal(results.filter(Boolean).length, 1, 'only the active reload request succeeds')
  assert(results.every(result => typeof result === 'boolean'))
  assert.equal(h.records.prompts.length, 1)
  assert.equal(h.reloads().length, 1)
  assert.equal(h.manager.documents.filter(doc => doc.filePath === file).length, 1)
  assert.equal(h.manager.documents.find(doc => doc.filePath === otherFile), other)
  assert.equal((await h.authority('get-document', { filePath: file })).content, '# Fresh concurrent replacement\n')
})

test('watcher changes during manual confirmation cannot open another dialog or overwrite input', async t => {
  let releaseDialog
  let answers = 0
  const gate = new Promise(resolve => { releaseDialog = resolve })
  const h = await createHarness(t, { respond: async () => {
    answers++
    if (answers === 1) { await gate; return { response: 1, checkboxChecked: true } }
    return { response: 0, checkboxChecked: true }
  } })
  const { file } = await openFixture(h)
  await insertThroughAuthority(h, file, '\nUNSAVED BEFORE MANUAL RELOAD\n')
  await atomicWrite(file, '# Disk replacement\n')
  const future = Math.floor(Date.now() / 1000) + 60
  await fsp.utimes(file, future, future)
  const pending = reload(h, file)
  await waitFor(() => h.records.prompts.length === 1, 'manual confirmation before watcher event')
  const readsBeforeWatcher = h.records.reads
  h.watchdog.emit('change', file)
  await h.manager.handleRemoteChange(file)
  assert.equal(h.records.prompts.length, 1)
  assert.equal(h.records.reads, readsBeforeWatcher)
  assert.equal(h.reloads().length, 0)
  releaseDialog()
  assert.equal(await pending, true)
  assert.equal(h.reloads().length, 1)
  assert.equal((await h.authority('get-document', { filePath: file })).content, '# Disk replacement\n')
})

test('a watcher read started before manual reload cannot discard its new authority afterwards', async t => {
  let block = false
  let reading = false
  let releaseRead
  const gate = new Promise(resolve => { releaseRead = resolve })
  const h = await createHarness(t, { beforeRead: async () => {
    if (block) { block = false; reading = true; await gate }
  } })
  const { file } = await openFixture(h)
  const { file: otherFile } = await openFixture(h, 'other.md', '# Unrelated\n')
  const other = h.manager.documents.find(doc => doc.filePath === otherFile)
  await atomicWrite(file, '# Manually loaded new authority\n')
  const future = Math.floor(Date.now() / 1000) + 60
  await fsp.utimes(file, future, future)
  block = true
  h.watchdog.emit('change', file)
  await waitFor(() => reading, 'watcher read started before manual reload')
  assert.equal(await reload(h, file), true)
  const fresh = h.manager.documents.find(doc => doc.filePath === file)
  releaseRead()
  await delay(30)
  assert.equal(h.reloads().length, 1)
  assert.equal(h.manager.documents.find(doc => doc.filePath === file), fresh)
  assert.equal(h.manager.documents.find(doc => doc.filePath === otherFile), other)
  assert.equal((await h.authority('get-document', { filePath: file })).content, '# Manually loaded new authority\n')
})

test('concurrent get-document requests create one shared authority before editing', async t => {
  const h = await createHarness(t)
  const file = await h.createFile('concurrent-open.md', '# One authority\n')
  const results = await Promise.all(Array.from({ length: 3 }, () => h.authority('get-document', { filePath: file })))
  assert.equal(h.manager.documents.length, 1)
  assert.deepEqual(results.map(result => result.startVersion), [0, 0, 0])
  const edited = await insertThroughAuthority(h, file, '\nSINGLE DIRTY AUTHORITY\n')
  assert.equal((await h.authority('get-document', { filePath: file })).content, edited)
  assert.deepEqual(await h.provider('get-file-modification-status'), [file])
})
