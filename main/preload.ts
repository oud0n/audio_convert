import { contextBridge, ipcRenderer, IpcRendererEvent, webUtils } from 'electron'

const handler = {
  send<T>(channel: string, value?: T) {
    ipcRenderer.send(channel, value)
  },
  on<T>(channel: string, callback: (...args: T[]) => void) {
    const subscription = (_event: IpcRendererEvent, ...args: T[]) =>
      callback(...args)
    ipcRenderer.on(channel, subscription)

    return () => {
      ipcRenderer.removeListener(channel, subscription)
    }
  },
  invoke<T>(channel: string, ...args: any[]): Promise<T> {
    return ipcRenderer.invoke(channel, ...args)
  },
  getPathForFile(file: File): string {
    return webUtils.getPathForFile(file)
  }
}

contextBridge.exposeInMainWorld('ipc', handler)

export type IpcHandler = typeof handler
