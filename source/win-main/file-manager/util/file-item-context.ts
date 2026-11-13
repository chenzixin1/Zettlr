/**
 * @ignore
 * BEGIN HEADER
 *
 * Contains:        File context menu
 * CVM-Role:        Controller
 * Maintainer:      Hendrik Erz
 * License:         GNU GPL v3
 *
 * Description:     This file displays a context menu for files.
 *
 * END HEADER
 */

import { trans } from '@common/i18n-renderer'
import showPopupMenu, { type AnyMenuItem } from '@common/modules/window-register/application-menu-helper'
import type { CodeFileDescriptor, MDFileDescriptor, OtherFileDescriptor } from '@dts/common/fsal'
import type { WindowControlsIPCAPI } from 'source/app/service-providers/windows'
import type { DocumentManagerIPCAPI } from 'source/app/service-providers/documents'
import { useConfigStore, useDocumentTreeStore } from 'source/pinia'

const ipcRenderer = window.ipc

export function displayFileContext (event: MouseEvent, fileObject: MDFileDescriptor|CodeFileDescriptor|OtherFileDescriptor, el: HTMLElement, callback: (clickedID: string) => void): void {
  const configStore = useConfigStore()
  const documentTreeStore = useDocumentTreeStore()
  const isMac = process.platform === 'darwin'
  const isWin = process.platform === 'win32'

  const template: AnyMenuItem[] = [
    {
      label: trans('Open in new tab'),
      id: 'new-tab',
      type: 'normal'
    },
    {
      label: trans('Properties'),
      id: 'properties',
      type: 'normal'
    },
    {
      type: 'separator'
    },
    {
      label: trans('Rename file'),
      id: 'menu.rename_file',
      accelerator: 'CmdOrCtrl+R',
      type: 'normal'
    },
    {
      label: trans('Duplicate file'),
      id: 'menu.duplicate_file',
      type: 'normal'
    },
    {
      label: trans('Delete file'),
      id: 'menu.delete_file',
      accelerator: 'CmdOrCtrl+Backspace',
      type: 'normal'
    },
    {
      type: 'separator'
    },
    {
      label: trans('Copy path'),
      id: 'menu.copy_path',
      type: 'normal'
    },
    {
      label: trans('Copy filename'),
      id: 'menu.copy_filename',
      type: 'normal'
    },
    {
      label: trans('Copy ID'),
      id: 'menu.copy_id',
      type: 'normal',
      enabled: fileObject.type === 'file' && fileObject.id !== ''
    },
    {
      type: 'separator'
    },
    {
      label: isMac ? trans('Reveal in Finder') : isWin ? trans('Reveal in Explorer') : trans('Reveal in File Browser'),
      id: 'menu.show_file',
      type: 'normal'
    }
  ]

  const isOpen = documentTreeStore.paneData.some(leaf => leaf.openFiles.some(doc => doc.path === fileObject.path))
  if (fileObject.type !== 'other' && isOpen) {
    template.splice(1, 0, {
      label: trans('Reload from disk'),
      accelerator: 'CmdOrCtrl+Alt+R',
      type: 'normal',
      action () {
        ipcRenderer.invoke('documents-provider', {
          command: 'reload-file',
          payload: { path: fileObject.path }
        } satisfies DocumentManagerIPCAPI).catch(err => console.error(err))
      }
    })
  }

  if (configStore.config.app.openFiles.includes(fileObject.path)) {
    template.push(
      { type: 'separator' },
      {
        id: 'menu.close_file',
        type: 'normal',
        label: trans('Close file')
      })
  }

  const point = { x: event.clientX, y: event.clientY }
  showPopupMenu(point, template, (clickedID) => {
    callback(clickedID) // TODO
    switch (clickedID) {
      case 'menu.copy_filename':
        navigator.clipboard.writeText(fileObject.name).catch(err => console.error(err))
        break
      case 'menu.copy_path':
        navigator.clipboard.writeText(fileObject.path).catch(err => console.error(err))
        break
      case 'menu.copy_id':
        if (fileObject.type === 'file') {
          navigator.clipboard.writeText(fileObject.id).catch(err => console.error(err))
        }
        break
      case 'menu.show_file':
        ipcRenderer.send('window-controls', {
          command: 'show-item-in-folder',
          payload: { itemPath: fileObject.path }
        } as WindowControlsIPCAPI)
        break
    }
  })
}
