import { useEffect, useState } from 'react'
import { Button, Input, Text, View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import Icon from '../../../components/Icon'
import RoleTabBar from '../../../components/RoleTabBar'
import { LOGIN_PAGE, getToken, inventoryApi } from '../../../services/api'
import { deniedHomeForConfirmedRole } from '../../../services/route-guard'
import { confirmedRoleForGuard } from '../../../services/session-cache'
import {
  inventoryPageCount,
  inventorySpecLabel,
  locationLabel,
  type InventoryProductRow,
} from '../../../services/inventory-list'
import { productSearchOnConfirm, productSearchOnInput } from '../../../services/product-search'
import './index.scss'

const PAGE_SIZE = 20

/** 全量库存。数字来自 GET /reports/inventory/products，不在页面里重算合计。 */
export default function InventoryListPage() {
  const [draft, setDraft] = useState('')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [items, setItems] = useState<InventoryProductRow[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [focus, setFocus] = useState(false)
  const [reload, setReload] = useState(0)

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    const home = deniedHomeForConfirmedRole(confirmedRoleForGuard(), '/pages/boss/inventory/index')
    if (home) Taro.reLaunch({ url: home })
  })

  useEffect(() => {
    if (!getToken()) return
    if (deniedHomeForConfirmedRole(confirmedRoleForGuard(), '/pages/boss/inventory/index')) return
    let cancelled = false
    setLoading(true)
    setError('')
    inventoryApi.products(keyword, page, PAGE_SIZE)
      .then((res) => {
        if (cancelled) return
        setItems(res.items ?? [])
        setTotal(res.total ?? 0)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setItems([])
        setError(e instanceof Error ? e.message : '加载库存失败')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => { cancelled = true }
  }, [keyword, page, reload])

  function search(value: string) {
    const next = value.trim()
    setDraft(next)
    setKeyword(next)
    setPage(1)
  }

  const pages = inventoryPageCount(total, PAGE_SIZE)

  return (
    <View className='page inv'>
      <View className='page-head'>
        <View className='page-head__main'>
          <Text className='page-head__title'>全部库存</Text>
          <Text className='page-head__sub'>按库位列在库，合计与库存报表同一口径</Text>
        </View>
      </View>

      <View className={`plist__search ${focus ? 'plist__search--focus' : ''}`}>
        <Icon name='search' color='#6B5F5A' size={44} />
        <Input
          className='plist__input'
          placeholder='搜索品名、规格、编码'
          confirmType='search'
          value={draft}
          onFocus={() => setFocus(true)}
          onBlur={() => setFocus(false)}
          onInput={(e) => {
            const next = productSearchOnInput(e.detail.value)
            if (next.loadNow !== null) search(next.loadNow)
            else setDraft(next.keyword)
          }}
          onConfirm={(e) => search(productSearchOnConfirm(e.detail.value))}
        />
      </View>

      {error ? (
        <View className='state'>
          <Text className='state__txt'>{error}</Text>
          <Button className='btn-primary' onClick={() => setReload((n) => n + 1)}>重新加载</Button>
        </View>
      ) : loading ? (
        <Text className='tip'>正在加载库存…</Text>
      ) : items.length === 0 ? (
        <View className='state'>
          <Text className='state__title'>{keyword ? '没有匹配的商品' : '还没有商品'}</Text>
          <Text className='state__txt'>{keyword ? '换个品名或编码再搜' : '商品建档后，这里显示各库位在库'}</Text>
        </View>
      ) : (
        items.map((row) => (
          <View key={row.productId} className='card inv__card'>
            <View className='inv__hd'>
              <View className='inv__main'>
                <Text className='inv__name'>{row.name}</Text>
                <Text className='inv__spec'>{inventorySpecLabel(row)}</Text>
              </View>
              {row.alert ? <Text className='tag tag--danger'>预警</Text> : null}
            </View>
            {row.locations.length === 0 ? (
              <Text className='inv__place'>没有批次</Text>
            ) : row.locations.map((place) => (
              <View key={`${row.productId}-${place.location ?? ''}`} className='kv'>
                <Text className='kv__k'>{locationLabel(place.location)}</Text>
                <Text className='num'>{place.onHand} {row.minUnit}</Text>
              </View>
            ))}
            <View className='kv inv__total'>
              <Text className='kv__k'>合计</Text>
              <Text className='num'>{row.onHand} {row.minUnit}</Text>
            </View>
          </View>
        ))
      )}

      {total > PAGE_SIZE ? (
        <View className='inv__pager'>
          <Button className='btn-ghost' disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</Button>
          <Text className='inv__pager-text'>{page} / {pages}</Text>
          <Button className='btn-ghost' disabled={page >= pages} onClick={() => setPage(page + 1)}>下一页</Button>
        </View>
      ) : null}
      <RoleTabBar />
    </View>
  )
}
