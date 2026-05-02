import { AsyncLocalStorage } from 'node:async_hooks'

export const requestAuthStore = new AsyncLocalStorage<string | undefined>()
