import Protocol from 'devtools-protocol'
import type { Request } from 'puppeteer'
import type { CDPSession } from 'puppeteer/lib/cjs/puppeteer/common/Connection'
import type { EventEmitter } from 'puppeteer/lib/cjs/puppeteer/common/EventEmitter'
import type { Frame } from 'puppeteer/lib/cjs/puppeteer/common/FrameManager'
import type { HTTPRequest } from 'puppeteer/lib/cjs/puppeteer/common/HTTPRequest'
import type { Handler } from 'puppeteer/lib/cjs/vendor/mitt/src'
import { EnchantOptions, interceptedHTTPRequests } from '.'
import { findModule } from './findModule'

export type DeferredRequestHandler = () => PromiseLike<void>

declare module 'puppeteer' {
  interface Request {
    isEnchanted: boolean
    continueRequestOverrides?: Overrides
    responseForRequest?: RespondOptions
    abortErrorCode?: ErrorCode
    shouldContinue: boolean
    shouldRespond: boolean
    shouldAbort: boolean
    onInterceptFinalized: (fn: Handler) => EventEmitter
    onInterceptAborted: (fn: Handler) => EventEmitter
    onInterceptResponded: (fn: Handler) => EventEmitter
    onInterceptContinued: (fn: Handler) => EventEmitter
    finalizeInterception(): Promise<void>
    defer(fn: DeferredRequestHandler): void
  }
}

export type EnchantedHTTPRequest = Request & {
  deferredRequestHandlers: DeferredRequestHandler[]
  _finalizeEmitter: EventEmitter
}

export const RequestInterceptionOutcome = {
  Aborted: 'aborted',
  Continued: 'continued',
  Responded: 'responded',
  Finalized: 'finalized',
} as const

export const enchantHTTPRequest = (options: EnchantOptions) => {
  const { modulePath, logger } = options
  const { error, info, debug } = logger
  const HTTPRequestModule = findModule(options, 'HTTPRequest')
  const oldKlass = HTTPRequestModule.HTTPRequest as typeof HTTPRequest & {
    isEnchanted?: boolean
  }

  if (oldKlass.isEnchanted) {
    debug(`HTTPRequest is already enchanted`)
    return
  }

  info(`Enchanting HTTPRequest`)

  const _EventEmitter = (() => {
    try {
      return require(findModule(options, 'EventEmitter')).EventEmitter
    } catch {
      return require('events') // 3.x
    }
  })()
  const debugError = findModule(options, 'helper').debugError

  const klass = function (
    client: CDPSession,
    frame: Frame,
    interceptionId: string,
    allowInterception: boolean,
    event: Protocol.Network.RequestWillBeSentEvent,
    redirectChain: HTTPRequest[]
  ) {
    const obj = (new oldKlass(
      client,
      frame,
      interceptionId,
      allowInterception,
      event,
      redirectChain
    ) as unknown) as EnchantedHTTPRequest

    obj.shouldContinue = true // Continue by default
    obj.shouldRespond = false
    obj.shouldAbort = false
    obj._finalizeEmitter = new _EventEmitter()
    obj.deferredRequestHandlers = []
    interceptedHTTPRequests[interceptionId] = obj

    obj.defer = function (fn: DeferredRequestHandler) {
      this.deferredRequestHandlers.push(fn)
    }

    obj.onInterceptFinalized = function (cb) {
      return this._finalizeEmitter.on(RequestInterceptionOutcome.Finalized, cb)
    }
    obj.onInterceptAborted = function (cb) {
      return this._finalizeEmitter.on(RequestInterceptionOutcome.Aborted, cb)
    }
    obj.onInterceptContinued = function (cb) {
      return this._finalizeEmitter.on(RequestInterceptionOutcome.Continued, cb)
    }
    obj.onInterceptResponded = function (cb) {
      return this._finalizeEmitter.on(RequestInterceptionOutcome.Responded, cb)
    }

    const oldContinue = oldKlass.prototype.continue

    obj.continue = async function (overrides) {
      this.continueRequestOverrides = overrides
      this.shouldContinue = true
    }

    const oldRespond = oldKlass.prototype.respond
    obj.respond = async function (response) {
      this.responseForRequest = response
      this.shouldRespond = true
    }

    const oldAbort = oldKlass.prototype.abort
    obj.abort = async function (errorCode) {
      this.shouldAbort = true
      this.abortErrorCode = errorCode
    }

    obj.finalizeInterception = async function () {
      return Promise.all(this.deferredRequestHandlers.map((fn) => fn()))
        .then(() => {
          if (this.shouldAbort) {
            return oldAbort
              .bind(this)(this.abortErrorCode)
              .then(() => {
                this._finalizeEmitter.emit(RequestInterceptionOutcome.Aborted)
                this._finalizeEmitter.emit(RequestInterceptionOutcome.Finalized)
              })
              .catch((e) => {
                error(e)
              })
          }
          if (this.shouldRespond)
            return (
              oldRespond
                //@ts-ignore This is okay to have undefined fields, the puppeteer core typing is incorrect
                .bind(this)(this.responseForRequest)
                .then(() => {
                  this._finalizeEmitter.emit(
                    RequestInterceptionOutcome.Responded
                  )
                  this._finalizeEmitter.emit(
                    RequestInterceptionOutcome.Finalized
                  )
                })
                .catch((e) => {
                  error(e)
                })
            )
          return oldContinue
            .bind(this)(this.continueRequestOverrides)
            .then(() => {
              this._finalizeEmitter.emit(RequestInterceptionOutcome.Continued)
              this._finalizeEmitter.emit(RequestInterceptionOutcome.Finalized)
            })
            .catch((e) => {
              error(e)
            })
        })
        .catch((e) => {
          error(e)
          debugError(e)
        })
        .finally(() => {
          delete interceptedHTTPRequests[interceptionId]
        })
    }
    return obj
  }
  klass.isEnchanted = true

  HTTPRequestModule.HTTPRequest = klass
}
