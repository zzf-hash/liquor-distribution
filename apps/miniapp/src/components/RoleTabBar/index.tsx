import { Text, View } from '@tarojs/components'
import Taro from '@tarojs/taro'
import { APP_ROLE } from '../../config/app-role'
import { normalizeRoute, sameTabSet, tabsForAppRole, tabsForRuntimeRole } from '../../config/role-tabs'
import { getRole } from '../../services/api'
import { openAppPage } from '../../services/navigation'
import './index.scss'

/**
 * 运行时角色与编译期 tab 不一致时的底部导航。
 * 与原生 tab 一致时返回空，避免叠两层。
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
              <Text className='role-tab__text'>{tab.text}</Text>
            </View>
          )
        })}
      </View>
    </View>
  )
}
