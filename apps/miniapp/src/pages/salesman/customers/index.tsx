import { useState } from 'react'
import { Button, Input, Text, View } from '@tarojs/components'
import Icon from '../../../components/Icon'
import Taro, { useDidShow } from '@tarojs/taro'
import { LOGIN_PAGE, SETTLEMENT_LABELS, customersApi, getToken } from '../../../services/api'
import type { CustomerRowDTO } from '../../../services/api'
import './index.scss'
import RoleTabBar from '../../../components/RoleTabBar'

/**
 * 我的客户（P1 全员端，rep token 自动过滤名下）：GET /customers 列表+搜索
 * （编码/名称/电话模糊）；行内电话一键拨号（Taro.makePhoneCall）。
 */
export default function SalesmanCustomersPage() {
  const [keyword, setKeyword] = useState('')
  const [items, setItems] = useState<CustomerRowDTO[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useDidShow(() => {
    if (!getToken()) {
      Taro.reLaunch({ url: LOGIN_PAGE })
      return
    }
    void load()
  })

  async function load(q?: string) {
    setLoading(true)
    setError('')
    try {
      const res = await customersApi.list({ q: q || undefined, pageSize: 200 })
      setItems(res.items ?? [])
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载客户失败')
    } finally {
      setLoading(false)
    }
  }

  function search() {
    void load(keyword.trim() || undefined)
  }

  function call(phone?: string | null) {
    if (!phone) {
      Taro.showToast({ title: '该客户没有登记电话', icon: 'none' })
      return
    }
    Taro.makePhoneCall({ phoneNumber: phone }).catch(() => undefined)
  }

  return (
    <View className='page'>
      <View className='topbar'>
        <Text className='topbar__title'>我的客户（{items.length}）</Text>
        <Text className='topbar__link' onClick={() => Taro.navigateTo({ url: '/pages/salesman/home/index' })}>工作台</Text>
      </View>

      <View className='search-pill'>
        <Icon name='search' color='#6B5F5A' size={44} />
        <Input
          className='search-pill__input'
          placeholder='搜客户名称、编码、电话'
          value={keyword}
          confirmType='search'
          onInput={(e) => setKeyword(e.detail.value)}
          onConfirm={search}
        />
      </View>

      {error ? (
        <View className='state'>
          <Text className='state__txt'>{error}</Text>
          <Button className='btn-primary' onClick={() => { void load() }}>重新加载</Button>
        </View>
      ) : loading ? (
        <Text className='tip'>正在加载客户…</Text>
      ) : items.length === 0 ? (
        <View className='state'>
          <Text className='state__title'>{keyword ? '没有匹配的客户' : '名下还没有客户'}</Text>
          <Text className='state__txt'>{keyword ? '换个名称或电话再搜' : '客户建档后会出现在这里'}</Text>
        </View>
      ) : (
        items.map((c) => (
          <View key={c.id} className='card ccard'>
            <View className='ccard__row'>
              <Text className='ccard__name'>{c.name}</Text>
              <Text className='icon-hit' onClick={() => call(c.phone)}>
                <Icon name='phone' color='#7A1F2B' size={40} />
              </Text>
            </View>
            <View className='ccard__row'>
              <Text className='ccard__meta'>
                {c.code ? `${c.code} · ` : ''}
                {SETTLEMENT_LABELS[c.settlement ?? ''] ?? c.settlement ?? '结算方式未设'}
                {c.abcLevel ? ` · ${c.abcLevel}类` : ''}
              </Text>
              <Text className='ccard__phone'>{c.phone || '无电话'}</Text>
            </View>
          </View>
        ))
      )}
      <RoleTabBar />
    </View>
  )
}
