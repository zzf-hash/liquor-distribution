/** 盖住越权页，避免 H5 在换页前画出对方角色的外壳。 */
export const ROUTE_GUARD_MASK_ID = 'ld-route-guard-mask'

export function mountRouteGuardMask(doc: Document): void {
  const root = doc.documentElement
  if (!root || doc.getElementById(ROUTE_GUARD_MASK_ID)) return
  const mask = doc.createElement('div')
  mask.id = ROUTE_GUARD_MASK_ID
  mask.setAttribute('aria-hidden', 'true')
  mask.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483647;background:#F7F4F1;'
  root.appendChild(mask)
}

export function removeRouteGuardMask(doc: Document): void {
  doc.getElementById(ROUTE_GUARD_MASK_ID)?.remove()
}
