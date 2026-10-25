import Taro from '@tarojs/taro'

type QueryBag = Record<string, string | undefined>

/**
 * 同时读取小程序 options 与 H5 $taroParams / router.params。
 * 只补路由参数，不改页面后续怎么用这些值。
 */
export function readRouteQuery(): Record<string, string> {
  const out: Record<string, string> = {}
  const inst = Taro.getCurrentInstance()
  const pages = Taro.getCurrentPages()
  const cur = pages[pages.length - 1] as { options?: QueryBag; $taroParams?: QueryBag } | undefined
  const bags: Array<QueryBag | undefined> = [
    inst?.router?.params as QueryBag | undefined,
    cur?.options,
    cur?.$taroParams,
  ]
  for (const bag of bags) {
    if (!bag) continue
    for (const [key, value] of Object.entries(bag)) {
      if (!value || key === '$taroTimestamp' || out[key]) continue
      try {
        out[key] = decodeURIComponent(value)
      } catch {
        out[key] = value
      }
    }
  }
  return out
}
