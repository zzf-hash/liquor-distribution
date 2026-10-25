export interface ProductSearchInput {
  keyword: string
  /** 非 null 时立刻按该字符串重搜。只有清空输入才是 ''。 */
  loadNow: string | null
}

/** 输入过程只更新关键字。被清空时立刻 load('')，不等确认。 */
export function productSearchOnInput(value: string): ProductSearchInput {
  if (value === '') return { keyword: '', loadNow: '' }
  return { keyword: value, loadNow: null }
}

/**
 * 键盘确认用事件里的当前值。
 * onConfirm 和最后一次 onInput 可能同一拍发生，这时 state 里的 keyword 还是上一次的。
 */
export function productSearchOnConfirm(detailValue: string): string {
  return detailValue
}
