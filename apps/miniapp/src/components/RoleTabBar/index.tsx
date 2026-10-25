import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { normalizeRoute, tabsForRuntimeRole } from '../../config/role-tabs'
import { getRole } from '../../services/api'
import { openAppPage } from '../../services/navigation'
import Icon, { iconForTab } from '../Icon'
import './index.scss'

/**
 * 统一包的底部导航。按登录后的后端角色渲染，客户和员工各看各的。
 * 不使用原生 tabBar：两套页面无法写进同一份 tabBar.list。
 */
export default function RoleTabBar() {
  const runtime = tabsForRuntimeRole(getRole())
  if (!runtime) return null
  const current = normalizeRoute(Taro.getCurrentInstance()?.router?.path ?? '')
  return (
    <View className='role-tab'>
      <View className='role-tab__spacer' />
      <View className='role-tab__bar'>
        {runtime.map((tab) => {
          const on = current === tab.pagePath
          return (
            <View
              key={tab.pagePath}
              className={`role-tab__item ${on ? 'role-tab__item--on' : ''}`}
              onClick={() => {
                if (!on) openAppPage(`/${tab.pagePath}`, 'tab')
              }}
            >
              <Icon name={iconForTab(tab.pagePath)} color={on ? '#7A1F2B' : '#6B5F5A'} size={44} />
              <Text className='role-tab__text'>{tab.text}</Text>
            </View>
          )
        })}
      </View>
    </View>
  )
}
