import { View } from '@tarojs/components'
import Taro, { useDidShow } from '@tarojs/taro'
import { LOGIN_PAGE } from '../../../services/api'

/**
 * 旧的客户登录地址。统一包只有一个登录页，打开这里就转到统一登录。
 */
export default function CustomerLoginPage() {
  useDidShow(() => {
    Taro.reLaunch({ url: LOGIN_PAGE })
  })
  return <View />
}
