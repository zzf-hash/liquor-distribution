import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { APP_ROLE } from '../../config/app-role'
import { normalizeRoute, sameTabSet, tabsForAppRole, tabsForRuntimeRole } from '../../config/role-tabs'
import { getRole } from '../../services/api'
import { openAppPage } from '../../services/navigation'
import Icon, { iconForTab } from '../Icon'
import './index.scss'

/**
 * 运行时角色与编译期 tab 不一致时的底部导航。
 * 客户包里角色一致时返回空，避免和原生 tab 叠两层。
 * 员工包没有原生 tab，登录后这里就是唯一的底部导航。
 */
export default function RoleTabBar() {
  const runtime = tabsForRuntimeRole(getRole())
  if (!runtime || sameTabSet(runtime, tabsForAppRole(APP_ROLE))) return null
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
